import { inngest } from "@/lib/inngest/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  getHistoryChanges,
  watchGmail,
  getDraftResolution,
} from "@/lib/gmail/client";
import { processIncomingEmail } from "@/lib/agent/run";
import { reconcileUnreportedUsage } from "@/lib/billing/meter";

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
 * 5. Save the newest historyId.
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
 * approveAndSend/rejectDraft (the in-app path) already update
 * email_actions.status correctly when the owner uses the dashboard.
 * This job exists only for the out-of-band case: the owner opened
 * Gmail itself and acted on the draft there, which the app has no
 * other way of learning about.
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