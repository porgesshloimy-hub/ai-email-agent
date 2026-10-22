import type { SupabaseServiceClient, ToolContext, ToolDefinition } from "./types";
import { isValidTimezone } from "@/lib/timezones";

/**
 * Owner-chat tools for looking at, finishing, and removing the two
 * kinds of "do this later" items the agent can hold:
 *
 *   - REMINDERS (agent_reminders) — a note back to the owner at a
 *     future time. In the owner's words these may be called reminders,
 *     tasks, to-dos or things to remember; there is no separate task
 *     table, so all of those mean this.
 *   - SCHEDULED EMAILS (agent_scheduled_actions) — an email the agent
 *     will send (or draft) at a future time.
 *
 * Before these existed the owner could create either kind but had no
 * way to finish or remove one: a reminder that was no longer needed
 * kept coming, and the agent had nothing it could do about it except
 * promise to stop.
 *
 * All four tools are chat-surface only, tenant-scoped by construction
 * (every query filters on context.tenantId), and report what actually
 * happened — the system prompt tells the model never to claim an item
 * is done or cancelled unless a tool call succeeded.
 */

/** Reminder statuses that still have something outstanding. */
const ACTIVE_REMINDER_STATUSES = ["pending", "delivered", "awaiting_ack", "passive_queue"];

interface ReminderRow {
  id: string;
  content: string;
  trigger_at: string;
  status: string;
}

interface ScheduledActionRow {
  id: string;
  to_email: string;
  subject: string;
  body: string;
  trigger_at: string;
}

async function getTimezone(supabase: SupabaseServiceClient, tenantId: string): Promise<string> {
  const { data } = await supabase.from("tenants").select("timezone").eq("id", tenantId).single();
  const tz = data?.timezone;
  return isValidTimezone(tz) ? (tz as string) : "UTC";
}

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

function describeReminderStatus(row: ReminderRow): string {
  switch (row.status) {
    case "pending":
      return new Date(row.trigger_at).getTime() > Date.now()
        ? "not due yet"
        : "due, not yet delivered";
    case "delivered":
    case "awaiting_ack":
      return "delivered, waiting for the owner to acknowledge";
    case "passive_queue":
      return "delivered, never acknowledged";
    default:
      return row.status;
  }
}

async function fetchActiveReminders(
  supabase: SupabaseServiceClient,
  tenantId: string
): Promise<ReminderRow[]> {
  const { data, error } = await supabase
    .from("agent_reminders")
    .select("id, content, trigger_at, status")
    .eq("tenant_id", tenantId)
    .in("status", ACTIVE_REMINDER_STATUSES)
    .order("trigger_at", { ascending: true });

  if (error) throw new Error(`Couldn't look up reminders: ${error.message}`);
  return (data ?? []) as ReminderRow[];
}

async function fetchPendingScheduledActions(
  supabase: SupabaseServiceClient,
  tenantId: string
): Promise<ScheduledActionRow[]> {
  const { data, error } = await supabase
    .from("agent_scheduled_actions")
    .select("id, to_email, subject, body, trigger_at")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .order("trigger_at", { ascending: true });

  if (error) throw new Error(`Couldn't look up scheduled emails: ${error.message}`);
  return (data ?? []) as ScheduledActionRow[];
}

/**
 * Finds the one item the owner means, from an exact id and/or a few
 * words from it. Deliberately conservative: anything other than
 * exactly one match comes back as "none" or "many" so the caller asks
 * rather than finishing or deleting the wrong thing. With neither an id
 * nor words given, a single outstanding item is unambiguous ("I did
 * it" when only one reminder exists); several are not.
 */
export type Resolution<T> =
  | { kind: "one"; item: T }
  | { kind: "none" }
  | { kind: "many"; items: T[] };

export function resolveItem<T extends { id: string }>(
  items: T[],
  args: { id?: unknown; match?: unknown },
  searchText: (item: T) => string
): Resolution<T> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const match = typeof args.match === "string" ? args.match.trim().toLowerCase() : "";

  if (id) {
    const found = items.find((item) => item.id === id);
    return found ? { kind: "one", item: found } : { kind: "none" };
  }

  if (match) {
    const words = match.split(/\s+/).filter(Boolean);
    const matches = items.filter((item) => {
      const text = searchText(item).toLowerCase();
      return text.includes(match) || words.every((word) => text.includes(word));
    });

    if (matches.length === 1) return { kind: "one", item: matches[0] };
    if (matches.length === 0) return { kind: "none" };
    return { kind: "many", items: matches };
  }

  if (items.length === 1) return { kind: "one", item: items[0] };
  if (items.length === 0) return { kind: "none" };
  return { kind: "many", items };
}

function listReminderLines(rows: ReminderRow[], timeZone: string): string {
  return rows
    .map((r) => `- id ${r.id}: "${r.content}" — ${formatWhen(r.trigger_at, timeZone)} (${describeReminderStatus(r)})`)
    .join("\n");
}

function listScheduledLines(rows: ScheduledActionRow[], timeZone: string): string {
  return rows
    .map((a) => `- id ${a.id}: email to ${a.to_email}, subject "${a.subject}" — scheduled for ${formatWhen(a.trigger_at, timeZone)}`)
    .join("\n");
}

const idAndMatchParameters = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "The exact id of the item, as shown by list_reminders. Preferred when you have it.",
    },
    match: {
      type: "string",
      description:
        "A few distinctive words from the item (e.g. 'supplier' for 'call the supplier'), used to find it when you don't have the id. If more than one item matches, nothing is changed and the matches are returned so you can ask the owner which one.",
    },
  },
};

export const listRemindersTool: ToolDefinition = {
  name: "list_reminders",

  description:
    "List everything the owner currently has scheduled for later: reminders (also called tasks or to-dos) and emails scheduled to be sent. Use this whenever the owner asks what reminders/tasks/scheduled emails they have, or before finishing or removing one when you're not sure which they mean.",

  parameters: { type: "object", properties: {} },

  surfaces: ["chat"],
  capability: "reminders",
  isAvailable: () => true,

  async execute(_args: Record<string, any>, context: ToolContext) {
    const [reminders, scheduled, timeZone] = await Promise.all([
      fetchActiveReminders(context.supabase, context.tenantId),
      fetchPendingScheduledActions(context.supabase, context.tenantId),
      getTimezone(context.supabase, context.tenantId),
    ]);

    if (reminders.length === 0 && scheduled.length === 0) {
      return "Nothing is scheduled — no outstanding reminders and no emails waiting to be sent.";
    }

    const sections: string[] = [];
    if (reminders.length > 0) sections.push(`Reminders:\n${listReminderLines(reminders, timeZone)}`);
    if (scheduled.length > 0) sections.push(`Scheduled emails:\n${listScheduledLines(scheduled, timeZone)}`);
    return sections.join("\n\n");
  },
};

/**
 * Removes the reminder's outstanding delivery attempt too — a queue
 * entry left behind would still be sent.
 */
async function clearQueueEntries(supabase: SupabaseServiceClient, tenantId: string, reminderId: string) {
  const { error } = await supabase
    .from("agent_outreach_queue")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("item_type", "reminder")
    .eq("item_id", reminderId);

  if (error) {
    console.error("MANAGE REMINDERS: failed to clear queued delivery:", error, { tenantId, reminderId });
  }
}

async function resolveReminderOrExplain(
  args: Record<string, any>,
  context: ToolContext
): Promise<{ reminder: ReminderRow } | { message: string }> {
  const [reminders, timeZone] = await Promise.all([
    fetchActiveReminders(context.supabase, context.tenantId),
    getTimezone(context.supabase, context.tenantId),
  ]);

  const resolution = resolveItem(reminders, args, (r) => r.content);

  if (resolution.kind === "one") return { reminder: resolution.item };

  if (resolution.kind === "none") {
    return {
      message:
        reminders.length === 0
          ? "There are no outstanding reminders, so nothing was changed."
          : `No outstanding reminder matches that, so nothing was changed. Current reminders:\n${listReminderLines(reminders, timeZone)}`,
    };
  }

  return {
    message: `More than one reminder could be meant, so nothing was changed. Ask the owner which one:\n${listReminderLines(resolution.items, timeZone)}`,
  };
}

export const completeReminderTool: ToolDefinition = {
  name: "complete_reminder",

  description:
    "Mark a reminder (also called a task or to-do) as DONE, so it stops coming up. Use when the owner says they've already taken care of it or that it's finished. Kept in history, unlike delete_reminder. With neither id nor match, works only if exactly one reminder is outstanding.",

  parameters: idAndMatchParameters,

  surfaces: ["chat"],
  capability: "reminders",
  isAvailable: () => true,

  async execute(args: Record<string, any>, context: ToolContext) {
    const resolved = await resolveReminderOrExplain(args, context);
    if ("message" in resolved) return resolved.message;

    const { reminder } = resolved;

    const { data, error } = await context.supabase
      .from("agent_reminders")
      .update({ status: "done" })
      .eq("id", reminder.id)
      .eq("tenant_id", context.tenantId)
      .select("id");

    if (error) return `Failed to mark that reminder done: ${error.message}. It is still active.`;
    if (!data || data.length === 0) return "That reminder couldn't be updated (it may have just changed). It was not marked done.";

    await clearQueueEntries(context.supabase, context.tenantId, reminder.id);
    return `Marked done: "${reminder.content}". It won't come up again.`;
  },
};

export const deleteReminderTool: ToolDefinition = {
  name: "delete_reminder",

  description:
    "Permanently delete a reminder (also called a task or to-do) so it never comes up again. Use when the owner says to delete, cancel, drop, forget, or stop a reminder. With neither id nor match, works only if exactly one reminder is outstanding. To remove an email scheduled for later, use cancel_scheduled_email instead.",

  parameters: idAndMatchParameters,

  surfaces: ["chat"],
  capability: "reminders",
  isAvailable: () => true,

  async execute(args: Record<string, any>, context: ToolContext) {
    const resolved = await resolveReminderOrExplain(args, context);
    if ("message" in resolved) return resolved.message;

    const { reminder } = resolved;

    await clearQueueEntries(context.supabase, context.tenantId, reminder.id);

    const { data, error } = await context.supabase
      .from("agent_reminders")
      .delete()
      .eq("id", reminder.id)
      .eq("tenant_id", context.tenantId)
      .select("id");

    if (error) return `Failed to delete that reminder: ${error.message}. It is still active.`;
    if (!data || data.length === 0) return "That reminder couldn't be deleted (it may have just changed). It is still active.";

    return `Deleted the reminder: "${reminder.content}". It won't come up again.`;
  },
};

export const cancelScheduledEmailTool: ToolDefinition = {
  name: "cancel_scheduled_email",

  description:
    "Cancel an email that was scheduled to be sent later, before it goes out. Use when the owner says to cancel, drop, or not send a scheduled email. Only works on emails that haven't been sent yet. With neither id nor match, works only if exactly one scheduled email is pending. Match on words from the recipient, subject or body.",

  parameters: idAndMatchParameters,

  surfaces: ["chat"],
  capability: "reminders",
  isAvailable: () => true,

  async execute(args: Record<string, any>, context: ToolContext) {
    const [actions, timeZone] = await Promise.all([
      fetchPendingScheduledActions(context.supabase, context.tenantId),
      getTimezone(context.supabase, context.tenantId),
    ]);

    const resolution = resolveItem(actions, args, (a) => `${a.to_email} ${a.subject} ${a.body}`);

    if (resolution.kind === "none") {
      return actions.length === 0
        ? "No emails are waiting to be sent, so nothing was changed. (If it already went out, it can't be cancelled.)"
        : `No pending scheduled email matches that, so nothing was changed. Currently scheduled:\n${listScheduledLines(actions, timeZone)}`;
    }

    if (resolution.kind === "many") {
      return `More than one scheduled email could be meant, so nothing was changed. Ask the owner which one:\n${listScheduledLines(resolution.items, timeZone)}`;
    }

    const action = resolution.item;

    // Only a still-pending action is cancellable: one that is already
    // executing or sent must not be silently reported as cancelled.
    const { data, error } = await context.supabase
      .from("agent_scheduled_actions")
      .update({ status: "cancelled", result_summary: "Cancelled by the owner before it was sent." })
      .eq("id", action.id)
      .eq("tenant_id", context.tenantId)
      .eq("status", "pending")
      .select("id");

    if (error) return `Failed to cancel that scheduled email: ${error.message}. It is still scheduled.`;
    if (!data || data.length === 0) {
      return "That email is no longer pending — it may have just been sent — so it could not be cancelled.";
    }

    return `Cancelled the email to ${action.to_email} ("${action.subject}"). It will not be sent.`;
  },
};
