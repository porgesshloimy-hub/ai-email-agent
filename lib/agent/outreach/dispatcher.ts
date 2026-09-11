import { createServiceSupabase } from "@/lib/supabase/server";
import { sendOwnerMessage } from "@/lib/notify";
import { persistChatMessage } from "@/lib/agent/chat-history/persist";

/**
 * Phase 5.2 — the shared send step for whatever
 * lib/agent/reminders/dispatch.ts (and, once built, watches/
 * suggestions) enqueues into agent_outreach_queue, PLUS the shared
 * notification helper lib/agent/scheduled-actions/dispatch.ts uses to
 * tell the owner what happened to a scheduled action once it fires.
 * Called by the scheduled Inngest function (lib/inngest/functions.ts's
 * dispatchPendingOutreach).
 *
 * SCOPE OF THIS PASS: only the scheduled/proactive path is implemented.
 * The original plan's "piggyback" path — attaching a queued item to the
 * tail of a reply the agent is already sending the owner anyway, when
 * they initiate contact themselves — is NOT wired up yet; that requires
 * hooking into lib/agent/chat.ts's reply-composition step and the Twilio
 * outbound path, which is real additional work left for a future pass.
 * "1 (occasionally 2) items per contact" from the plan is also narrowed
 * to a flat 1-per-tenant-per-cycle here — the "occasionally 2 if short/
 * related" refinement is deferred.
 *
 * CHANNEL SUPPORT (revised this pass): the dashboard chat widget
 * (`owner_chat_messages`, via persistChatMessage — the same table/
 * function the widget's own send/receive routes use, with
 * channel: "web" matching their convention) is now a real, working
 * proactive-send path, added specifically because this tenant's Twilio
 * SMS isn't actually configured yet. SMS still works end-to-end when a
 * tenant genuinely has a phone_number on file and prefers it — the
 * channel selection below tries the tenant's configured preference
 * first and only falls back to the widget when SMS isn't actually usable
 * (no phone number, or `proactive_contact_channel` isn't set to a real
 * channel), rather than the reminder silently never going out. Google
 * Chat and real owner-facing email still have no proactive-send path in
 * this codebase at all — a tenant configured for 'chat' (meaning Google
 * Chat, not the dashboard widget — an unfortunate naming collision
 * inherited from the existing `proactive_contact_channel` enum, see
 * note on resolveDeliveryChannel below) or 'email' falls back to the
 * dashboard widget, loudly logged, same as before.
 */

export interface TenantOutreachSettings {
  timezone: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  proactive_contact_channel: string | null;
  phone_number?: string | null;
}

export async function dispatchAllPendingOutreach(): Promise<{
  tenantsProcessed: number;
  sent: number;
  skippedQuietHours: number;
}> {
  const supabase = createServiceSupabase();

  const { data: rows, error } = await supabase
    .from("agent_outreach_queue")
    .select("tenant_id");

  if (error) {
    console.error("DISPATCH ALL PENDING OUTREACH: queue lookup failed:", error);
    return { tenantsProcessed: 0, sent: 0, skippedQuietHours: 0 };
  }

  const tenantIds = Array.from(new Set((rows ?? []).map((row) => row.tenant_id)));

  let sent = 0;
  let skippedQuietHours = 0;

  for (const tenantId of tenantIds) {
    const result = await dispatchOutreachForTenant(tenantId);
    if (result === "sent") sent++;
    if (result === "quiet_hours") skippedQuietHours++;
  }

  const summary = { tenantsProcessed: tenantIds.length, sent, skippedQuietHours };
  console.log("DISPATCH ALL PENDING OUTREACH complete:", summary);
  return summary;
}

type DispatchOutcome = "sent" | "quiet_hours" | "nothing_queued" | "failed" | "unsupported_item_type";

/**
 * Sends at most one queued item for a single tenant. Exported separately
 * from dispatchAllPendingOutreach so the future piggyback path can call
 * it directly for one tenant at the moment the owner initiates contact,
 * without needing to scan every tenant's queue.
 */
export async function dispatchOutreachForTenant(
  tenantId: string
): Promise<DispatchOutcome> {
  const supabase = createServiceSupabase();

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("timezone, quiet_hours_start, quiet_hours_end, proactive_contact_channel, phone_number")
    .eq("id", tenantId)
    .single();

  if (tenantError || !tenant) {
    console.error("DISPATCH OUTREACH: tenant lookup failed:", tenantError, { tenantId });
    return "failed";
  }

  if (isWithinQuietHours(tenant as TenantOutreachSettings)) {
    return "quiet_hours";
  }

  const { data: queueItem, error: queueError } = await supabase
    .from("agent_outreach_queue")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (queueError) {
    console.error("DISPATCH OUTREACH: queue item lookup failed:", queueError, { tenantId });
    return "failed";
  }

  if (!queueItem) {
    return "nothing_queued";
  }

  if (queueItem.item_type !== "reminder") {
    // Watches/suggestions aren't wired up to enqueue anything yet (later
    // phases) — nothing should actually land here today, but log loudly
    // rather than silently dropping it if something does.
    console.error("DISPATCH OUTREACH: unsupported item_type, leaving queued:", {
      tenantId,
      itemType: queueItem.item_type,
    });
    return "unsupported_item_type";
  }

  return dispatchReminderItem(supabase, tenantId, queueItem, tenant as TenantOutreachSettings);
}

async function dispatchReminderItem(
  supabase: ReturnType<typeof createServiceSupabase>,
  tenantId: string,
  queueItem: { id: string; item_id: string },
  tenant: TenantOutreachSettings
): Promise<DispatchOutcome> {
  const { data: reminder, error: reminderError } = await supabase
    .from("agent_reminders")
    .select("id, content, status, attempt_count")
    .eq("id", queueItem.item_id)
    .single();

  if (reminderError || !reminder) {
    console.error("DISPATCH OUTREACH: reminder lookup failed, removing stale queue entry:", reminderError, {
      tenantId,
      reminderId: queueItem.item_id,
    });
    await supabase.from("agent_outreach_queue").delete().eq("id", queueItem.id);
    return "failed";
  }

  if (reminder.status !== "pending" && reminder.status !== "awaiting_ack") {
    // Already resolved (acknowledged, or moved elsewhere) between being
    // queued and now — nothing to send.
    await supabase.from("agent_outreach_queue").delete().eq("id", queueItem.id);
    return "nothing_queued";
  }

  const sent = await notifyTenant(tenantId, tenant, `Reminder: ${reminder.content}`);

  if (!sent) {
    // Leave the queue entry and the reminder's status alone — retried
    // next cycle. Not bumping attempt_count/last_attempted_at here
    // deliberately: those track REAL delivery attempts (see
    // dispatch.ts's retry-spacing logic), and a send that never reached
    // the owner isn't one.
    return "failed";
  }

  const { error: updateError } = await supabase
    .from("agent_reminders")
    .update({
      status: "awaiting_ack",
      attempt_count: (reminder.attempt_count ?? 0) + 1,
      last_attempted_at: new Date().toISOString(),
    })
    .eq("id", reminder.id);

  if (updateError) {
    console.error("DISPATCH OUTREACH: failed to update reminder after send:", updateError, {
      tenantId,
      reminderId: reminder.id,
    });
  }

  await supabase.from("agent_outreach_queue").delete().eq("id", queueItem.id);

  return "sent";
}

/**
 * Sends one message to the tenant's owner via whichever channel is
 * actually usable, and returns whether it went out. Exported so
 * lib/agent/scheduled-actions/dispatch.ts can reuse the exact same
 * channel-selection logic to tell the owner what happened to a
 * scheduled action once it fires, instead of duplicating it.
 *
 * NOTE on naming: `proactive_contact_channel` is an existing schema enum
 * ('sms' | 'chat' | 'email') from before the dashboard chat widget's
 * proactive-send path existed. 'chat' in that enum was written with
 * Google Chat in mind, which still has no real proactive-send path (see
 * the module comment above) — it is NOT the dashboard widget. Renaming
 * the enum value would be a larger, separate migration, so for now:
 * 'sms' means real SMS, and everything else (including 'chat', 'email',
 * or unset) routes to the dashboard widget, which is the one channel
 * that's actually real for every tenant regardless of what's configured
 * (no per-tenant setup needed — it's the same dashboard every tenant
 * already has). A future per-tenant notification-preference feature
 * should add a distinct enum value for the widget explicitly rather than
 * overloading 'chat' further.
 */
export async function notifyTenant(
  tenantId: string,
  tenant: TenantOutreachSettings,
  message: string
): Promise<boolean> {
  const preferSms = tenant.proactive_contact_channel === "sms";

  if (preferSms && tenant.phone_number) {
    const sent = await sendOwnerMessage(tenantId, message);
    if (sent) return true;
    // A real SMS attempt actually failed (Twilio error, etc.) — leave
    // this as a failure rather than silently rerouting to the widget,
    // so the caller's normal retry/backoff logic applies. A tenant with
    // no phone_number at all (the common case right now) never reaches
    // this branch — see the fallback below.
    return false;
  }

  if (preferSms && !tenant.phone_number) {
    console.log(
      "NOTIFY TENANT: preferred channel is sms but no phone_number is on file — falling back to the dashboard chat widget:",
      { tenantId }
    );
  } else if (tenant.proactive_contact_channel && tenant.proactive_contact_channel !== "sms") {
    console.error(
      "NOTIFY TENANT: configured channel has no real proactive-send path yet, falling back to the dashboard chat widget:",
      { tenantId, configuredChannel: tenant.proactive_contact_channel }
    );
  }

  const persisted = await persistChatMessage(tenantId, "agent", message, "web");
  return persisted !== null;
}

/**
 * quiet_hours_start/quiet_hours_end are Postgres `time` columns (come
 * back from supabase-js as "HH:MM:SS" strings), compared against the
 * current time-of-day IN THE TENANT'S OWN TIMEZONE — not server time,
 * consistent with this codebase's existing "today is defined by the
 * business's own timezone" principle (see lib/agent/date-context.ts).
 * Handles the overnight case (start > end, e.g. 22:00-07:00) as a
 * wraparound window.
 */
function isWithinQuietHours(tenant: TenantOutreachSettings): boolean {
  if (!tenant.quiet_hours_start || !tenant.quiet_hours_end) {
    return false;
  }

  let currentTime: string;

  try {
    currentTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: tenant.timezone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch (error) {
    console.error("QUIET HOURS CHECK: invalid timezone, treating as never-quiet:", error, {
      timezone: tenant.timezone,
    });
    return false;
  }

  const start = tenant.quiet_hours_start.slice(0, 5);
  const end = tenant.quiet_hours_end.slice(0, 5);

  if (start <= end) {
    return currentTime >= start && currentTime < end;
  }

  // Overnight window, e.g. 22:00 -> 07:00
  return currentTime >= start || currentTime < end;
}
