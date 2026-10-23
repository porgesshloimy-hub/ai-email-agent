import type { SupabaseServiceClient, ToolContext, ToolDefinition } from "./types";
import { createReminder } from "@/lib/agent/reminders/create";
import { createScheduledEmailAction } from "@/lib/agent/scheduled-actions/create";
import { writeMemory } from "@/lib/agent/memory/write";
import { MEMORY_SLOTS, isKnownSlotKey } from "@/lib/agent/memory/slots";
import { resolveCustomerReference } from "@/lib/agent/memory/owner-intent";
import { resolveSendCapability } from "@/lib/agent/permissions";
import { isValidTimezone } from "@/lib/timezones";

/**
 * Owner-chat tools for the three "do this for me later / keep this in
 * mind" requests: create a reminder, schedule an email, remember
 * something.
 *
 * Why these exist. Until now the ONLY way a reminder, scheduled email
 * or memory got saved was the cheap intent classifier in
 * lib/agent/memory/owner-intent.ts, which runs before the main agent.
 * That is a good fast path, but it fails quietly by design — an error,
 * a model that answers in text instead of calling its tool, or a
 * message holding two requests at once all fall through to the main
 * agent. The main agent had no way to save anything, yet its prompt
 * said it could, so it would answer "I'm setting it now" and then do
 * nothing: a confident claim backed by no action, which is the exact
 * failure this codebase exists to prevent.
 *
 * With these tools the main agent can really do the thing when the
 * classifier doesn't, and its claim becomes checkable: each tool
 * reports precisely what happened, and the system prompt forbids saying
 * something was saved/set/scheduled unless the tool said so. The
 * classifier path is unchanged and still handles the common case
 * cheaply; when it does handle a message the agent never runs, so
 * nothing is created twice.
 *
 * Chat-surface only, tenant-scoped by construction.
 */

// A full date-time AND a real UTC offset must be present, e.g.
// 2026-10-23T11:00:00-04:00 or 2026-10-23T15:00:00Z. An ISO string
// without an offset is read as the server's timezone (UTC on Vercel),
// which silently files an 11:00 AM New York reminder for 11:00 UTC. The
// pattern is anchored on the whole string on purpose: a bare date such
// as "2026-10-23" ends in "-23", which a looser "ends with an offset"
// test would mistake for one.
const FULL_DATETIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

function checkTriggerAt(triggerAt: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof triggerAt !== "string" || !triggerAt.trim()) {
    return { ok: false, message: "I need a specific date and time for this, so nothing was saved. Ask the owner when." };
  }

  const value = triggerAt.trim();

  if (!FULL_DATETIME_WITH_OFFSET.test(value) || Number.isNaN(new Date(value).getTime())) {
    return {
      ok: false,
      message:
        "triggerAt must be a full ISO 8601 date-time WITH a UTC offset (for example 2026-10-23T11:00:00-04:00), resolved against the business timezone and current date in your instructions. Nothing was saved — try again with the offset.",
    };
  }

  return { ok: true, value };
}

async function getTimezone(supabase: SupabaseServiceClient, tenantId: string): Promise<string> {
  const { data } = await supabase.from("tenants").select("timezone").eq("id", tenantId).single();
  const tz = data?.timezone;
  return isValidTimezone(tz) ? (tz as string) : "UTC";
}

function formatWhen(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" });
}

/** These tools report failure as text; one that throws would be replaced by a generic "something went wrong". */
async function failSoft(toolName: string, tenantId: string, run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    console.error(`OWNER REQUESTS (${toolName}) failed:`, error, { tenantId });
    const reason = error instanceof Error ? error.message : String(error);
    return `I couldn't do that: ${reason}. Nothing was saved.`;
  }
}

export const createReminderTool: ToolDefinition = {
  name: "create_reminder",

  description:
    "Create a reminder that texts/notifies the OWNER at a specific future time. Use whenever the owner asks you to remind them of something (also called a task or to-do). Resolve relative phrases ('in an hour', 'Friday at 11') into an exact date-time using the current date and business timezone given in your instructions. A time more than a few minutes in the past is rejected — if the time the owner named has already passed, tell them and ask for a new one. Only tell the owner a reminder is set if this tool says it was saved.",

  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "What to remind the owner of, as a short standalone statement (e.g. 'Light Shabbos candles').",
      },
      triggerAt: {
        type: "string",
        description:
          "When to remind them: an ISO 8601 date-time WITH a UTC offset, e.g. 2026-10-23T11:00:00-04:00, in the business timezone.",
      },
    },
    required: ["content", "triggerAt"],
  },

  surfaces: ["chat"],
  capability: "reminders",
  isAvailable: () => true,

  async execute(args: Record<string, any>, context: ToolContext) {
    return failSoft("create_reminder", context.tenantId, async () => {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return "I need to know what to remind the owner about, so nothing was saved.";

      const time = checkTriggerAt(args.triggerAt);
      if (!time.ok) return time.message;

      const result = await createReminder(
        { tenantId: context.tenantId, content, triggerAt: time.value },
        context.supabase
      );

      if ("error" in result) return `The reminder was NOT saved: ${result.error}`;

      const timeZone = await getTimezone(context.supabase, context.tenantId);
      return `Saved. Reminder "${content}" is set for ${formatWhen(result.triggerAt, timeZone)} (${timeZone}).`;
    });
  },
};

export const scheduleEmailTool: ToolDefinition = {
  name: "schedule_email",

  description:
    "Schedule an email to be sent to someone else at a specific future time (e.g. 'email the Smiths Monday morning to confirm'). Needs the recipient's explicit email address, a subject, the full body, and an exact send time. If sending isn't currently authorized, the email is saved as a Gmail draft at that time instead — the result says which. Not for reminders to the owner (use create_reminder). Only tell the owner an email is scheduled if this tool says it was.",

  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "The recipient's full email address." },
      subject: { type: "string", description: "A concise subject line." },
      body: { type: "string", description: "The full email body, written as the owner would send it." },
      triggerAt: {
        type: "string",
        description: "When to send: an ISO 8601 date-time WITH a UTC offset, e.g. 2026-10-26T09:00:00-04:00, in the business timezone.",
      },
    },
    required: ["to", "subject", "body", "triggerAt"],
  },

  surfaces: ["chat"],
  capability: "reminders",
  isAvailable: () => true,

  async execute(args: Record<string, any>, context: ToolContext) {
    return failSoft("schedule_email", context.tenantId, async () => {
      const to = typeof args.to === "string" ? args.to.trim() : "";
      const subject = typeof args.subject === "string" ? args.subject.trim() : "";
      const body = typeof args.body === "string" ? args.body.trim() : "";

      if (!to.includes("@")) return "I need the recipient's full email address, so nothing was scheduled. Ask the owner for it.";
      if (!subject || !body) return "I need both a subject and a body, so nothing was scheduled.";

      const time = checkTriggerAt(args.triggerAt);
      if (!time.ok) return time.message.replace("saved", "scheduled");

      const result = await createScheduledEmailAction(
        { tenantId: context.tenantId, toEmail: to, subject, body, triggerAt: time.value },
        context.supabase
      );

      if ("error" in result) return `The email was NOT scheduled: ${result.error}`;

      const timeZone = await getTimezone(context.supabase, context.tenantId);
      const when = formatWhen(result.triggerAt, timeZone);

      // The email is already saved at this point. If the permission lookup
      // fails, say the cautious thing (it will be a draft) rather than let
      // an error here turn into "nothing was saved" — which would be false.
      let capability: string = "unknown";
      try {
        capability = await resolveSendCapability(context.tenantId);
      } catch (error) {
        console.error("OWNER REQUESTS (schedule_email): send-capability lookup failed after saving:", error, {
          tenantId: context.tenantId,
        });
      }

      return capability === "send"
        ? `Scheduled. The email to ${to} (subject "${subject}") will be sent ${when} (${timeZone}).`
        : `Scheduled, with a caveat: sending isn't currently enabled, so at ${when} (${timeZone}) it will be saved as a Gmail draft to ${to} (subject "${subject}") instead of being sent automatically. Tell the owner that.`;
    });
  },
};

export const rememberTool: ToolDefinition = {
  name: "remember",

  description:
    "Save something the owner told you to keep in mind. kind='fact' for something to know (about a customer or the business); kind='instruction' for a standing rule about how to act going forward ('always mention our holiday hours'); kind='always_remember' for a fact the owner wants permanently front-of-mind, never lost. Facts can be about one customer (pass `customer`) or the business generally (omit it). Only tell the owner something is remembered if this tool says it was saved.",

  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The fact or rule, written as a clear standalone statement in your own words.",
      },
      kind: {
        type: "string",
        enum: ["fact", "instruction", "always_remember"],
        description: "fact = something to know; instruction = a standing behavioral rule; always_remember = a fact to keep permanently front-of-mind.",
      },
      customer: {
        type: "string",
        description: "For a fact about one specific customer: their email address, or their name exactly as the owner said it. Omit for business-wide facts and for instructions.",
      },
      slotKey: {
        type: "string",
        enum: Object.keys(MEMORY_SLOTS),
        description: "Only if the fact is a structured value matching one of these known fields (e.g. a customer's shipping address). Omit otherwise.",
      },
    },
    required: ["content", "kind"],
  },

  surfaces: ["chat"],
  capability: "memory",
  isAvailable: () => true,

  async execute(args: Record<string, any>, context: ToolContext) {
    return failSoft("remember", context.tenantId, async () => {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      const kind = args.kind;

      if (!content) return "There's nothing to save — the content was empty.";
      if (kind !== "fact" && kind !== "instruction" && kind !== "always_remember") {
        return "kind must be one of: fact, instruction, always_remember. Nothing was saved.";
      }

      if (kind === "instruction") {
        const { error } = await context.supabase
          .from("agent_instruction_notes")
          .insert({ tenant_id: context.tenantId, content, source_thread_id: null, active: true });

        if (error) return `The instruction was NOT saved: ${error.message}`;
        return `Saved as a standing instruction: "${content}".`;
      }

      const customerHint = typeof args.customer === "string" ? args.customer.trim() : "";
      const resolution = await resolveCustomerReference(context.tenantId, customerHint || undefined);

      if (resolution.status === "ambiguous") {
        return `Nothing saved yet — more than one customer matches "${customerHint}": ${resolution.candidates.join(", ")}. Ask the owner which one.`;
      }
      if (resolution.status === "not_found") {
        return `Nothing saved — I couldn't find a customer matching "${customerHint}". Ask the owner for their email address.`;
      }

      const slotKey = typeof args.slotKey === "string" && isKnownSlotKey(args.slotKey) ? args.slotKey : null;
      const pinned = kind === "always_remember";

      const written = await writeMemory({
        tenantId: context.tenantId,
        scope: resolution.status === "resolved" ? "customer" : "tenant",
        customerEmail: resolution.status === "resolved" ? resolution.email : null,
        content,
        source: "owner_stated",
        sourceThreadId: null,
        slotKey,
        alwaysSurface: pinned,
        pinSource: pinned ? "owner" : null,
      });

      if (!written) return "The memory was NOT saved — the write failed.";

      const about = resolution.status === "resolved" ? ` for ${resolution.email}` : "";
      return pinned
        ? `Saved, and pinned so it's always kept in mind${about}: "${content}".`
        : `Saved${about}: "${content}".`;
    });
  },
};
