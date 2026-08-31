import { inngest } from "@/lib/inngest/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  getHistoryChanges,
  watchGmail,
  getDraftResolution,
} from "@/lib/gmail/client";
import { processIncomingEmail } from "@/lib/agent/run";
import { reconcileUnreportedUsage } from "@/lib/billing/meter";
import { handleChatMessage } from "@/lib/agent/chat";

/**
 * Fires on every Gmail push notification.
 *
 * Gmail sends:
 *
 * {
 *   emailAddress,
 *   historyId
 * }
 *
 * We:
 *
 * 1. Find the tenant that owns the Gmail account.
 * 2. Compare Gmail history against our stored history_id.
 * 3. Retrieve newly-added messages.
 * 4. Send each message through the AI agent.
 * 5. Resolve any draft-sent/draft-deleted events found in the same
 *    history diff, in real time.
 * 6. Save the newest historyId.
 *
 * IMPORTANT:
 *
 * Inngest concurrency is NOT our duplicate protection.
 * The database idempotency constraint in processIncomingEmail()
 * is the final protection against duplicate processing.
 */
export const handleGmailHistoryChanged =
  inngest.createFunction(
    {
      id:
        "handle-gmail-history-changed",

      /**
       * Prevent the exact same Gmail notification from causing
       * multiple function executions within Inngest's
       * idempotency window.
       */
      idempotency:
        "event.data.emailAddress + '-' + event.data.historyId",

      /**
       * Keep Gmail processing for a mailbox serialized as much
       * as Inngest allows.
       *
       * This is useful for resource control, but is NOT relied
       * upon for correctness.
       */
      concurrency: {
        limit: 1,

        key:
          "event.data.emailAddress",
      },
    },

    {
      event:
        "gmail/history.changed",
    },

    async ({
      event,
      step,
    }) => {
      const {
        emailAddress,
        historyId,
      } = event.data;

      const supabase =
        createServiceSupabase();

      /**
       * --------------------------------------------------------
       * FIND GMAIL CONNECTION
       * --------------------------------------------------------
       */

      const connection =
        await step.run(
          "find-gmail-connection",
          async () => {
            const {
              data,
              error,
            } =
              await supabase
                .from(
                  "gmail_connections"
                )
                .select(
                  "tenant_id, history_id"
                )
                .eq(
                  "gmail_address",
                  emailAddress
                )
                .single();

            if (error) {
              throw new Error(
                `Failed to find Gmail connection: ${error.message}`
              );
            }

            return data;
          }
        );

      if (!connection) {
        return {
          skipped:
            "no matching Gmail connection",
        };
      }

      const tenantId =
        connection.tenant_id;

      /**
       * --------------------------------------------------------
       * HISTORY CURSOR
       * --------------------------------------------------------
       */

      const startingHistoryId =
        connection.history_id ??
        historyId;

      console.log(
        "GMAIL SYNC START",
        {
          emailAddress,

          notificationHistoryId:
            historyId,

          storedHistoryId:
            connection.history_id,

          startingHistoryId,
        }
      );

      /**
       * --------------------------------------------------------
       * GET HISTORY CHANGES
       * --------------------------------------------------------
       */

      const historyResult =
        await step.run(
          "diff-history",
          async () => {
            return getHistoryChanges(
              tenantId,
              startingHistoryId
            );
          }
        );

      const newMessages =
        historyResult.messages;

      console.log(
        "GMAIL MESSAGES TO PROCESS:",
        {
          tenantId,

          emailAddress,

          notificationHistoryId:
            historyId,

          startingHistoryId,

          latestHistoryId:
            historyResult.historyId,

          messageCount:
            newMessages.length,

          messageIds:
            newMessages.map(
              (message) =>
                message.messageId
            ),
        }
      );

      /**
       * --------------------------------------------------------
       * PROCESS MESSAGES
       * --------------------------------------------------------
       *
       * processIncomingEmail() now contains a database-level
       * idempotency guard.
       */

      for (
        const message of newMessages
      ) {
        await step.run(
          `process-${message.messageId}`,
          async () => {
            const result =
              await processIncomingEmail({
                tenantId,

                threadId:
                  message.threadId,

                messageId:
                  message.messageId,

                from:
                  message.from,

                subject:
                  message.subject,

                bodyText:
                  message.bodyText,
              });

            console.log(
              "GMAIL MESSAGE PROCESS RESULT:",
              {
                tenantId,

                messageId:
                  message.messageId,

                result,
              }
            );

            return result;
          }
        );
      }

      /**
       * --------------------------------------------------------
       * RESOLVE DRAFT EVENTS IN REAL TIME
       * --------------------------------------------------------
       *
       * Draft events detected in this same history diff (sent via
       * SENT label added, or deleted) are resolved immediately,
       * instead of waiting for reconcilePendingDrafts' 10-minute
       * cron.
       *
       * The .eq("status", "pending_approval") guard makes this safe
       * against a race with approveAndSend/rejectDraft: if the owner
       * used the in-app buttons, the row is already "sent"/"rejected"
       * by the time this runs, so the update below matches zero rows
       * and is a harmless no-op. reconcilePendingDrafts remains as a
       * safety net for any event this push notification path misses
       * (e.g. a watch that hasn't yet been renewed to the broadened
       * label scope).
       */

      const draftEvents =
        historyResult.draftEvents ?? [];

      for (const draftEvent of draftEvents) {
        await step.run(
          `resolve-draft-event-${draftEvent.messageId}`,
          async () => {
            const newStatus =
              draftEvent.event === "sent" ? "sent" : "rejected";

            const { data: updated, error } = await supabase
              .from("email_actions")
              .update({
                status: newStatus,
                resolved_at: new Date().toISOString(),
              })
              .eq("tenant_id", tenantId)
              .eq("gmail_draft_message_id", draftEvent.messageId)
              .eq("status", "pending_approval")
              .select("id");

            if (error) {
              throw new Error(
                `Failed to resolve draft event for message ${draftEvent.messageId}: ${error.message}`
              );
            }

            console.log("REALTIME DRAFT EVENT RESOLVED:", {
              tenantId,
              messageId: draftEvent.messageId,
              event: draftEvent.event,
              newStatus,
              rowsUpdated: updated?.length ?? 0,
            });
          }
        );
      }

      /**
       * --------------------------------------------------------
       * UPDATE HISTORY CURSOR
       * --------------------------------------------------------
       *
       * Only update the cursor after all messages have
       * successfully passed through the agent.
       */

      await step.run(
        "update-history-id",
        async () => {
          const {
            error,
          } =
            await supabase
              .from(
                "gmail_connections"
              )
              .update({
                history_id:
                  historyResult.historyId,
              })
              .eq(
                "tenant_id",
                tenantId
              );

          if (error) {
            throw new Error(
              `Failed to update Gmail history ID: ${error.message}`
            );
          }

          console.log(
            "GMAIL HISTORY UPDATED:",
            {
              tenantId,

              previousHistoryId:
                startingHistoryId,

              newHistoryId:
                historyResult.historyId,
            }
          );
        }
      );

      return {
        processed:
          newMessages.length,

        draftEventsResolved:
          draftEvents.length,

        historyId:
          historyResult.historyId,
      };
    }
  );


/**
 * Gmail watch() expires roughly every 7 days.
 *
 * This runs every 12 hours and renews watches that are
 * approaching expiration.
 */
export const renewGmailWatches =
  inngest.createFunction(
    {
      id:
        "renew-gmail-watches",
    },

    {
      cron:
        "0 */12 * * *",
    },

    async ({
      step,
    }) => {
      const supabase =
        createServiceSupabase();

      /**
       * Find Gmail connections whose watch expires
       * within the next 24 hours.
       */
      const connections =
        await step.run(
          "find-expiring-watches",
          async () => {
            const expiration =
              new Date(
                Date.now() +
                  24 *
                    60 *
                    60 *
                    1000
              ).toISOString();

            const {
              data,
              error,
            } =
              await supabase
                .from(
                  "gmail_connections"
                )
                .select(
                  "tenant_id, watch_expiry"
                )
                .not(
                  "watch_expiry",
                  "is",
                  null
                )
                .lt(
                  "watch_expiry",
                  expiration
                );

            if (error) {
              throw new Error(
                `Failed to find expiring Gmail watches: ${error.message}`
              );
            }

            return data ?? [];
          }
        );

      let renewed = 0;

      for (
        const connection of connections
      ) {
        await step.run(
          `renew-watch-${connection.tenant_id}`,
          async () => {
            const watch =
              await watchGmail(
                connection.tenant_id
              );

            const expiration =
              watch.expiration;

            if (!expiration) {
              throw new Error(
                "Gmail watch did not return an expiration"
              );
            }

            const watchExpiry =
              new Date(
                Number(
                  expiration
                )
              ).toISOString();

            const {
              error,
            } =
              await supabase
                .from(
                  "gmail_connections"
                )
                .update({
                  watch_expiry:
                    watchExpiry,

                  history_id:
                    watch.historyId ??
                    undefined,
                })
                .eq(
                  "tenant_id",
                  connection.tenant_id
                );

            if (error) {
              throw new Error(
                `Failed to save renewed Gmail watch: ${error.message}`
              );
            }

            renewed++;
          }
        );
      }

      return {
        checked:
          connections.length,

        renewed,
      };
    }
  );


/**
 * Retries usage events that failed to report to Stripe.
 *
 * Runs hourly as a safety net.
 */
export const reconcileUsageReporting =
  inngest.createFunction(
    {
      id:
        "reconcile-usage-reporting",
    },

    {
      cron:
        "0 * * * *",
    },

    async ({
      step,
    }) => {
      const supabase =
        createServiceSupabase();

      const tenantIds =
        await step.run(
          "find-tenants-with-unreported-usage",
          async () => {
            const {
              data,
              error,
            } =
              await supabase
                .from(
                  "usage_events"
                )
                .select(
                  "tenant_id"
                )
                .eq(
                  "stripe_reported",
                  false
                );

            if (error) {
              throw new Error(
                `Failed to find unreported usage: ${error.message}`
              );
            }

            return [
              ...new Set(
                (data ?? []).map(
                  (row) =>
                    row.tenant_id
                )
              ),
            ];
          }
        );

      let totalRetried = 0;

      for (
        const tenantId of tenantIds
      ) {
        const result =
          await step.run(
            `reconcile-${tenantId}`,
            () =>
              reconcileUnreportedUsage(
                tenantId
              )
          );

        totalRetried +=
          result.retried;
      }

      return {
        tenantsChecked:
          tenantIds.length,

        eventsRetried:
          totalRetried,
      };
    }
  );


/**
 * Catches drafts that the business owner sent or deleted directly in
 * Gmail instead of using the in-app approve/reject buttons.
 *
 * This is now a SAFETY NET rather than the primary detection path —
 * handleGmailHistoryChanged resolves most of these in real time via
 * the broadened Gmail watch (INBOX + SENT + DRAFT). This job remains
 * to catch anything that path misses (e.g. a tenant whose watch
 * hasn't yet been renewed to the new label scope, a missed push
 * notification, etc).
 *
 * approveAndSend/rejectDraft (the in-app path) already update
 * email_actions.status correctly when the owner uses the dashboard.
 *
 * Runs every 10 minutes. Mirrors the exact status/resolved_at shape
 * that approveAndSend/rejectDraft already write, so the approvals
 * dashboard query needs no changes.
 */
export const reconcilePendingDrafts = inngest.createFunction(
  {
    id: "reconcile-pending-drafts",
  },

  {
    cron: "*/10 * * * *",
  },

  async ({ step }) => {
    const supabase = createServiceSupabase();

    const pendingActions = await step.run(
      "find-pending-drafts",
      async () => {
        const { data, error } = await supabase
          .from("email_actions")
          .select("id, tenant_id, gmail_draft_id, gmail_draft_message_id")
          .eq("status", "pending_approval")
          .not("gmail_draft_id", "is", null);

        if (error) {
          throw new Error(
            `Failed to find pending drafts: ${error.message}`
          );
        }

        return data ?? [];
      }
    );

    console.log("RECONCILE PENDING DRAFTS START:", {
      pendingCount: pendingActions.length,
    });

    let sentCount = 0;
    let deletedCount = 0;
    let unknownCount = 0;

    for (const action of pendingActions) {
      const resolution = await step.run(
        `check-draft-${action.id}`,
        async () => {
          return getDraftResolution(
            action.tenant_id,
            action.gmail_draft_id as string,
            action.gmail_draft_message_id
          );
        }
      );

      if (resolution === "still_draft") {
        continue;
      }

      if (resolution === "unknown") {
        unknownCount++;

        console.warn("RECONCILE DRAFT STATUS UNKNOWN:", {
          emailActionId: action.id,
          tenantId: action.tenant_id,
          draftId: action.gmail_draft_id,
        });

        continue;
      }

      const newStatus = resolution === "sent" ? "sent" : "rejected";

      await step.run(`update-action-${action.id}`, async () => {
        const { error } = await supabase
          .from("email_actions")
          .update({
            status: newStatus,
            resolved_at: new Date().toISOString(),
          })
          .eq("id", action.id)
          /**
           * Guard against a race with the in-app approve/reject path:
           * only apply this update if the row is still pending_approval
           * at write time. If the owner clicked approve/reject in the
           * dashboard between our read and our write, that action wins.
           */
          .eq("status", "pending_approval");

        if (error) {
          throw new Error(
            `Failed to update reconciled email action ${action.id}: ${error.message}`
          );
        }
      });

      if (resolution === "sent") {
        sentCount++;
      } else {
        deletedCount++;
      }

      console.log("RECONCILE DRAFT RESOLVED:", {
        emailActionId: action.id,
        tenantId: action.tenant_id,
        draftId: action.gmail_draft_id,
        resolution,
        newStatus,
      });
    }

    console.log("RECONCILE PENDING DRAFTS COMPLETE:", {
      checked: pendingActions.length,
      sentCount,
      deletedCount,
      unknownCount,
    });

    return {
      checked: pendingActions.length,
      sentCount,
      deletedCount,
      unknownCount,
    };
  }
);
/**
 * ------------------------------------------------------------
 * Delayed, batched owner-chat replies
 * ------------------------------------------------------------
 *
 * A deliberately bounded, two-phase wait rather than an open-ended
 * typing-tracking loop:
 *
 *   Phase A — wait a fixed 2-4 seconds after the message is sent.
 *   Decision — did the owner start typing at any point during Phase A?
 *     - Yes → Phase B is 5-9 seconds (they seem to be composing a
 *       follow-up; give them real room to actually send it).
 *     - No → Phase B is a shorter 2-4 seconds (just the ordinary
 *       "let it feel like a person, not a bot firing back instantly"
 *       pause).
 *   Respond — once Phase B elapses, reply to everything sent since the
 *   last reply.
 *
 * If the owner sends another message at ANY point (during Phase A or
 * Phase B), this run stands down entirely and the new message's own
 * triggered run starts the whole two-phase wait over again, relative
 * to itself — exactly "start that over again." This also means the
 * wait is naturally bounded (worst case ~4s + 9s ≈ 13s before a reply
 * begins, per message that doesn't get superseded) — no open-ended
 * loop, no separate safety cap needed the way a continuously-extending
 * wait would require.
 *
 * Fires once per NEW owner message that isn't a reply to a pending
 * confirmation (app/api/agent-chat/send/route.ts decides that up
 * front — confirmation replies like "yes"/"cancel" stay instant,
 * since an artificial thinking-pause doesn't belong on a quick
 * acknowledgment).
 */
export const processDelayedChatReply = inngest.createFunction(
  {
    id: "process-delayed-chat-reply",

    /**
     * Resource control only, not correctness — the "check if I'm the
     * latest" step is what actually prevents duplicate/overlapping
     * replies, the same way the Gmail history handler's comment above
     * notes concurrency limits aren't relied on for correctness either.
     */
    concurrency: {
      limit: 5,
      key: "event.data.tenantId",
    },
  },

  {
    event: "chat/owner-message.sent",
  },

  async ({ event, step }) => {
    const { tenantId, ownerMessageId, ownerMessageCreatedAt, channel } = event.data as {
      tenantId: string;
      ownerMessageId: string;
      ownerMessageCreatedAt: string;
      channel: string;
    };

    /**
     * Returns { standDown: true } if a newer unprocessed owner message
     * exists (meaning this run's message has been superseded — its own
     * newly-triggered run will handle everything from scratch), or the
     * full unprocessed batch (including this message) if this run's
     * message is still the most recent one.
     */
    async function checkLatest(stepId: string) {
      return step.run(stepId, async () => {
        const supabase = createServiceSupabase();

        const { data: unprocessed, error } = await supabase
          .from("owner_chat_messages")
          .select("id, content, created_at")
          .eq("tenant_id", tenantId)
          .eq("role", "owner")
          .eq("processed", false)
          .order("created_at", { ascending: true });

        if (error) {
          throw new Error(`Failed to gather pending owner messages: ${error.message}`);
        }

        const rows = unprocessed ?? [];
        const mostRecent = rows[rows.length - 1];

        if (rows.length === 0 || mostRecent.id !== ownerMessageId) {
          return { standDown: true as const, rows: [] };
        }

        return { standDown: false as const, rows };
      });
    }

    // Phase A: fixed 2-4 second pause.
    const phaseAMs = await step.run("compute-phase-a", async () => {
      return (2 + Math.floor(Math.random() * 3)) * 1000; // 2-4s
    });

    await step.sleep("phase-a-wait", `${phaseAMs}ms`);

    const afterPhaseA = await checkLatest("check-after-phase-a");

    if (afterPhaseA.standDown) {
      console.log("DELAYED CHAT REPLY: standing down after phase A, not the latest message", {
        tenantId,
        ownerMessageId,
      });
      return { processed: false };
    }

    // Did the owner start typing at any point between sending this
    // message and now (the end of Phase A)? A point-in-time check, not
    // a rolling freshness window — Phase A is a fixed, short duration,
    // so "typing recorded after this message was sent" is exactly
    // "did they start typing during phase A."
    const startedTyping = await step.run("check-typing-after-phase-a", async () => {
      const supabase = createServiceSupabase();

      const { data: tenant } = await supabase
        .from("tenants")
        .select("owner_last_typing_at")
        .eq("id", tenantId)
        .single();

      if (!tenant?.owner_last_typing_at) return false;

      return new Date(tenant.owner_last_typing_at) > new Date(ownerMessageCreatedAt);
    });

    // Phase B: 5-9s if the owner appeared to start composing a
    // follow-up, otherwise a shorter 2-4s.
    const phaseBMs = await step.run("compute-phase-b", async () => {
      return startedTyping
        ? (5 + Math.floor(Math.random() * 5)) * 1000 // 5-9s
        : (2 + Math.floor(Math.random() * 3)) * 1000; // 2-4s
    });

    await step.sleep("phase-b-wait", `${phaseBMs}ms`);

    const batch = await checkLatest("check-after-phase-b");

    if (batch.standDown || batch.rows.length === 0) {
      console.log("DELAYED CHAT REPLY: standing down after phase B, not the latest message", {
        tenantId,
        ownerMessageId,
      });
      return { processed: false };
    }

    /**
     * Combined into ONE synthesized message rather than multiple
     * separate trailing turns — reuses handleChatMessage()'s entire
     * existing, tested pipeline (persona resolution, tool handling,
     * message-splitting, persistence) with zero duplication, at the
     * cost of the batched messages appearing as one turn's content
     * instead of several consecutive user turns. The model still sees
     * and can address every message — the "|||" splitting mechanism it
     * already knows how to use lets it reply to each point separately
     * if that reads more naturally.
     */
    const combinedText =
      batch.rows.length === 1
        ? batch.rows[0].content
        : batch.rows
            .map((row, i) =>
              i === 0 ? row.content : `(They then added, before you could reply:)\n${row.content}`
            )
            .join("\n\n");

    await step.run("generate-and-persist-reply", async () => {
      await handleChatMessage(tenantId, combinedText, {
        channel,
        skipPersistingOwnerMessage: true,
      });

      const supabase = createServiceSupabase();

      const { error } = await supabase
        .from("owner_chat_messages")
        .update({ processed: true })
        .in(
          "id",
          batch.rows.map((r) => r.id)
        );

      if (error) {
        throw new Error(`Failed to mark batch as processed: ${error.message}`);
      }
    });

    console.log("DELAYED CHAT REPLY: processed batch", {
      tenantId,
      batchSize: batch.rows.length,
      phaseAMs,
      startedTyping,
      phaseBMs,
    });

    return { processed: true, batchSize: batch.rows.length };
  }
);
