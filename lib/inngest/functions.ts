import { inngest } from "@/lib/inngest/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  getHistoryChanges,
  readMessage,
} from "@/lib/gmail/client";
import { processIncomingEmail } from "@/lib/agent/run";
import { reconcileUnreportedUsage } from "@/lib/billing/meter";

/**
 * Fires on every Gmail push notification.
 *
 * Gmail sends us an email address + historyId through Pub/Sub.
 * We use the previously stored history_id to find the actual
 * new messages, read them, and pass them to the AI agent.
 */
export const handleGmailHistoryChanged = inngest.createFunction(
  {
    id: "handle-gmail-history-changed",
  },
  {
    event: "gmail/history.changed",
  },
  async ({ event, step }) => {
    const {
      emailAddress,
      historyId: notificationHistoryId,
    } = event.data;

    const supabase = createServiceSupabase();

    /**
     * Find the tenant that owns this Gmail account.
     */
    const tenantId = await step.run(
      "find-tenant",
      async () => {
        const { data, error } = await supabase
          .from("gmail_connections")
          .select("tenant_id")
          .eq("gmail_address", emailAddress)
          .single();

        if (error) {
          console.error(
            "Failed to find tenant for Gmail address:",
            error
          );
        }

        return data?.tenant_id ?? null;
      }
    );

    if (!tenantId) {
      return {
        skipped: "no matching tenant",
        emailAddress,
      };
    }

    /**
     * Get the last Gmail history ID we successfully processed.
     */
    const connection = await step.run(
      "get-gmail-connection",
      async () => {
        const { data, error } = await supabase
          .from("gmail_connections")
          .select("history_id")
          .eq("tenant_id", tenantId)
          .single();

        if (error) {
          throw new Error(
            `Failed to load Gmail connection: ${error.message}`
          );
        }

        return data;
      }
    );

    if (!connection?.history_id) {
      return {
        skipped: "no stored history_id",
        tenantId,
      };
    }

    /**
     * Ask Gmail what changed since our last processed history ID.
     */
    let changes;

    try {
      changes = await step.run(
        "diff-history",
        async () => {
          return getHistoryChanges(
            tenantId,
            connection.history_id
          );
        }
      );
    } catch (error) {
      console.error(
        "Failed to read Gmail history:",
        error
      );

      return {
        error: "gmail_history_failed",
        tenantId,
      };
    }

    /**
     * Read every newly-added message.
     */
    const newMessages: {
      threadId: string;
      messageId: string;
      from: string;
      subject: string;
      bodyText: string;
    }[] = [];

    for (const change of changes) {
      const message = await step.run(
        `read-message-${change.messageId}`,
        async () => {
          return readMessage(
            tenantId,
            change.messageId
          );
        }
      );

      /**
       * Don't process messages sent by the business itself.
       *
       * Otherwise the agent could see its own outgoing email,
       * interpret it as a new incoming message, and potentially
       * respond to itself.
       */
      const fromLower = message.from.toLowerCase();
      const ownAddress = emailAddress.toLowerCase();

      if (fromLower.includes(ownAddress)) {
        continue;
      }

      newMessages.push({
        threadId: message.threadId,
        messageId: message.messageId,
        from: message.from,
        subject: message.subject,
        bodyText: message.bodyText,
      });
    }

    /**
     * IMPORTANT:
     *
     * Only advance history_id after we successfully retrieved
     * the messages above.
     *
     * This prevents us from silently losing emails if Gmail
     * history retrieval fails.
     */
    await step.run(
      "update-history-id",
      async () => {
        const { error } = await supabase
          .from("gmail_connections")
          .update({
            history_id: notificationHistoryId,
          })
          .eq("tenant_id", tenantId);

        if (error) {
          throw new Error(
            `Failed to update Gmail history_id: ${error.message}`
          );
        }
      }
    );

    /**
     * Send each incoming email through the AI agent.
     *
     * processIncomingEmail() is responsible for:
     *
     * - checking tenant permissions
     * - checking business rules
     * - loading business knowledge
     * - asking OpenAI what to do
     * - creating drafts when approval is required
     * - sending replies when autonomous sending is allowed
     * - creating/proposing calendar events
     * - recording usage
     */
    for (const message of newMessages) {
      await step.run(
        `process-${message.messageId}`,
        async () => {
          await processIncomingEmail({
            tenantId,
            threadId: message.threadId,
            messageId: message.messageId,
            from: message.from,
            subject: message.subject,
            bodyText: message.bodyText,
          });
        }
      );
    }

    return {
      processed: newMessages.length,
      historyId: notificationHistoryId,
      tenantId,
      emailAddress,
    };
  }
);

/**
 * Gmail's watch() expires roughly every 7 days.
 *
 * This runs every 12 hours and should renew watches that are
 * approaching expiration.
 */
export const renewGmailWatches = inngest.createFunction(
  {
    id: "renew-gmail-watches",
  },
  {
    cron: "0 */12 * * *",
  },
  async ({ step }) => {
    const supabase = createServiceSupabase();

    const connections = await step.run(
      "find-expiring-gmail-watches",
      async () => {
        const expiryThreshold = new Date(
          Date.now() + 24 * 60 * 60 * 1000
        ).toISOString();

        const { data, error } = await supabase
          .from("gmail_connections")
          .select(
            "tenant_id, gmail_address, watch_expiry"
          )
          .lt("watch_expiry", expiryThreshold);

        if (error) {
          throw new Error(
            `Failed to find expiring Gmail watches: ${error.message}`
          );
        }

        return data ?? [];
      }
    );

    /**
     * The actual watch renewal will call watchGmail()
     * and update history_id/watch_expiry.
     *
     * We'll wire this fully once the basic push pipeline
     * has been verified.
     */
    return {
      checked: true,
      connectionsFound: connections.length,
    };
  }
);

/**
 * Retries any usage events that failed to report to Stripe.
 *
 * Runs hourly as a safety net.
 */
export const reconcileUsageReporting = inngest.createFunction(
  {
    id: "reconcile-usage-reporting",
  },
  {
    cron: "0 * * * *",
  },
  async ({ step }) => {
    const supabase = createServiceSupabase();

    const tenantIds = await step.run(
      "find-tenants-with-unreported-usage",
      async () => {
        const { data, error } = await supabase
          .from("usage_events")
          .select("tenant_id")
          .eq("stripe_reported", false);

        if (error) {
          throw new Error(
            `Failed to find unreported usage: ${error.message}`
          );
        }

        return [
          ...new Set(
            (data ?? []).map(
              (row) => row.tenant_id
            )
          ),
        ];
      }
    );

    let totalRetried = 0;

    for (const tenantId of tenantIds) {
      const result = await step.run(
        `reconcile-${tenantId}`,
        () =>
          reconcileUnreportedUsage(
            tenantId
          )
      );

      totalRetried += result.retried;
    }

    return {
      tenantsChecked: tenantIds.length,
      eventsRetried: totalRetried,
    };
  }
);