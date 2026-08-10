import { inngest } from "@/lib/inngest/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { processIncomingEmail } from "@/lib/agent/run";
import { reconcileUnreportedUsage } from "@/lib/billing/meter";

/**
 * Fires on every Gmail push notification. Looks up which tenant owns this
 * Gmail address, diffs history since the last processed historyId to find
 * new messages, then runs each through the agent pipeline.
 */
export const handleGmailHistoryChanged = inngest.createFunction(
  { id: "handle-gmail-history-changed" },
  { event: "gmail/history.changed" },
  async ({ event, step }) => {
    const { emailAddress, historyId } = event.data;
    const supabase = createServiceSupabase();

    const tenantId = await step.run("find-tenant", async () => {
      const { data } = await supabase
        .from("gmail_connections")
        .select("tenant_id")
        .eq("gmail_address", emailAddress)
        .single();
      return data?.tenant_id;
    });

    if (!tenantId) return { skipped: "no matching tenant" };

    const newMessages = await step.run("diff-history", async () => {
      // Use gmail.users.history.list(startHistoryId=...) against the stored
      // history_id to fetch only new messages, then update history_id to `historyId`.
      // Stubbed here — see lib/gmail/client.ts for the authed client pattern.
      return [] as { threadId: string; messageId: string; from: string; subject: string; bodyText: string }[];
    });

    for (const msg of newMessages) {
      await step.run(`process-${msg.messageId}`, async () => {
        await processIncomingEmail({
          tenantId,
          threadId: msg.threadId,
          messageId: msg.messageId,
          from: msg.from,
          subject: msg.subject,
          bodyText: msg.bodyText,
        });
      });
    }

    return { processed: newMessages.length };
  }
);

/**
 * Gmail's watch() expires roughly every 7 days — renew it before it lapses
 * or push notifications silently stop.
 */
export const renewGmailWatches = inngest.createFunction(
  { id: "renew-gmail-watches" },
  { cron: "0 */12 * * *" }, // every 12 hours
  async ({ step }) => {
    // Query gmail_connections where watch_expiry < now() + 24h, call
    // gmail.users.watch() again for each, update watch_expiry.
    return { checked: true };
  }
);

/**
 * Retries any usage_events that failed to report to Stripe (outage, tenant
 * hadn't connected billing yet at the time, etc.) so nothing silently goes
 * unbilled. Runs hourly — usage reporting is otherwise real-time via
 * recordUsage(), so this is just a safety net, not the primary path.
 */
export const reconcileUsageReporting = inngest.createFunction(
  { id: "reconcile-usage-reporting" },
  { cron: "0 * * * *" }, // hourly
  async ({ step }) => {
    const supabase = createServiceSupabase();

    const tenantIds = await step.run("find-tenants-with-unreported-usage", async () => {
      const { data } = await supabase
        .from("usage_events")
        .select("tenant_id")
        .eq("stripe_reported", false);
      return [...new Set((data ?? []).map((r) => r.tenant_id))];
    });

    let totalRetried = 0;
    for (const tenantId of tenantIds) {
      const result = await step.run(`reconcile-${tenantId}`, () => reconcileUnreportedUsage(tenantId));
      totalRetried += result.retried;
    }

    return { tenantsChecked: tenantIds.length, eventsRetried: totalRetried };
  }
);
