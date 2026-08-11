import { inngest } from "@/lib/inngest/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  getHistoryChanges,
  watchGmail,
} from "@/lib/gmail/client";
import { processIncomingEmail } from "@/lib/agent/run";
import { reconcileUnreportedUsage } from "@/lib/billing/meter";

/**
 * Fires on every Gmail push notification.
 *
 * Gmail sends:
 * {
 *   emailAddress,
 *   historyId
 * }
 *
 * We:
 * 1. Find the tenant that owns the Gmail account.
 * 2. Compare Gmail history against our stored history_id.
 * 3. Retrieve newly-added messages.
 * 4. Send each message through the AI agent.
 * 5. Save the newest historyId so we don't process the same
 *    messages again.
 */
export const handleGmailHistoryChanged =
  inngest.createFunction(
    {
      id: "handle-gmail-history-changed",

      concurrency: {
        limit: 1,
        key: "event.data.emailAddress",
      },
    },
    {
      event: "gmail/history.changed",
    },
    async ({ event, step }) => {
      const {
        emailAddress,
        historyId,
      } = event.data;

      const supabase =
        createServiceSupabase();

      /**
       * Find the Gmail connection belonging
       * to this email address.
       */
      const connection =
        await step.run(
          "find-gmail-connection",
          async () => {
            const { data, error } =
              await supabase
                .from("gmail_connections")
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
       * Determine which history ID we should
       * use as the starting point.
       *
       * On the very first notification, there
       * may not yet be a stored history_id.
       */
      const startingHistoryId =
        connection.history_id ?? historyId;

        console.log("GMAIL SYNC START", {
  emailAddress,
  notificationHistoryId: historyId,
  storedHistoryId: connection.history_id,
  startingHistoryId,
});

      /**
       * Retrieve all messages added since the
       * last processed history ID.
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

      /**
       * Process every newly received email
       * through the AI agent.
       */
      for (const message of newMessages) {
        await step.run(
          `process-${message.messageId}`,
          async () => {
            await processIncomingEmail({
              tenantId,
              threadId:
                message.threadId,
              messageId:
                message.messageId,
              from: message.from,
              subject:
                message.subject,
              bodyText:
                message.bodyText,
            });
          }
        );
      }

      /**
       * IMPORTANT:
       *
       * Only update our stored history ID after
       * all messages have successfully gone
       * through the agent.
       *
       * This prevents us from losing messages if
       * the AI processing fails halfway through.
       */
      await step.run(
        "update-history-id",
        async () => {
          const { error } =
            await supabase
              .from("gmail_connections")
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
 * This runs every 12 hours and renews watches
 * that are approaching expiration.
 */
export const renewGmailWatches =
  inngest.createFunction(
    {
      id: "renew-gmail-watches",
    },
    {
      cron: "0 */12 * * *",
    },
    async ({ step }) => {
      const supabase =
        createServiceSupabase();

      /**
       * Find Gmail connections whose watch
       * expires within the next 24 hours.
       */
      const connections =
        await step.run(
          "find-expiring-watches",
          async () => {
            const expiration =
              new Date(
                Date.now() +
                  24 * 60 * 60 * 1000
              ).toISOString();

            const { data, error } =
              await supabase
                .from("gmail_connections")
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

      /**
       * Renew each Gmail watch.
       */
      for (const connection of connections) {
        await step.run(
          `renew-watch-${connection.tenant_id}`,
          async () => {
            const watch =
              await watchGmail(
                connection.tenant_id
              );

            /**
             * Gmail returns an expiration
             * timestamp in milliseconds.
             */
            const expiration =
              watch.expiration;

            if (!expiration) {
              throw new Error(
                "Gmail watch did not return an expiration"
              );
            }

            const watchExpiry =
              new Date(
                Number(expiration)
              ).toISOString();

            const { error } =
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
 * Retries usage events that failed to report
 * to Stripe.
 *
 * Runs hourly as a safety net.
 */
export const reconcileUsageReporting =
  inngest.createFunction(
    {
      id: "reconcile-usage-reporting",
    },
    {
      cron: "0 * * * *",
    },
    async ({ step }) => {
      const supabase =
        createServiceSupabase();

      /**
       * Find tenants that have unreported
       * usage events.
       */
      const tenantIds =
        await step.run(
          "find-tenants-with-unreported-usage",
          async () => {
            const { data, error } =
              await supabase
                .from("usage_events")
                .select("tenant_id")
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

      /**
       * Retry each tenant's failed usage
       * reporting.
       */
      for (const tenantId of tenantIds) {
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