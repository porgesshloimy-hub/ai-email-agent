import { createServiceSupabase } from "@/lib/supabase/server";
import { runChatCompletion, isProviderConfigured } from "@/lib/agent/llm";
import type { LlmToolDefinition } from "@/lib/agent/llm";
import { MODEL_CATALOG, DEFAULT_AI_MODEL } from "@/lib/agent/models";
import type { AIProvider } from "@/lib/agent/models";
import { buildCurrentDateContext } from "@/lib/agent/date-context";

import { writeMemory } from "./write";
import { isKnownSlotKey, MEMORY_SLOTS } from "./slots";
import { extractEmailAddress } from "./util";
import { createReminder } from "@/lib/agent/reminders/create";
import { checkAndResolveAcknowledgment } from "@/lib/agent/reminders/ack-detection";
import { createScheduledEmailAction } from "@/lib/agent/scheduled-actions/create";
import { resolveSendCapability } from "@/lib/agent/permissions";

/**
 * Phase 2.6 — classifies an owner chat message into one of the intents
 * the plan defined, and, for the intents this pass actually implements,
 * acts on it directly rather than routing it through the normal chat
 * tool-calling loop. Wired into lib/agent/chat.ts right after the
 * pending-confirmation check (Phase 5's existing yes/no resolution takes
 * priority — see that file) and before persona/tool setup, so a
 * recognized instruction/pin/reminder is handled deterministically
 * without spending a full agent loop on it.
 *
 * IMPLEMENTED: memory_note, instruction, pin_request, reminder,
 * acknowledgment, and (new this pass) scheduled_action — "send an email
 * tomorrow morning" and similar. A scheduled_action is deliberately NOT
 * a reminder: a reminder only ever notifies the owner, while a
 * scheduled_action actually sends or drafts a real email once due — see
 * lib/agent/scheduled-actions/create.ts and dispatch.ts. Only send_email
 * is supported as a schedulable tool right now (matching the only two
 * real chat-surface email tools, send_email/compose_email_draft) — a
 * scheduled calendar action or similar isn't built.
 * NOT implemented: watch (Phase 4 — classified but answered with a
 * plain "not set up yet" rather than silently doing nothing).
 * ordinary_reply is not an action at all — it means "let the normal
 * chat pipeline handle this," so parseOwnerMessage returns
 * { handled: false } for it (and for anything the classifier fails to
 * produce a confident answer for — see the fail-open note below).
 */

export interface OwnerIntentResult {
  handled: boolean;
  responseText?: string;
}

const CHEAP_PROVIDER: AIProvider = "openai";
const cheapestOpenAiModel = MODEL_CATALOG.openai.models.find(
  (model) => model.tier === "Cheapest"
);
const CHEAP_MODEL: string = cheapestOpenAiModel?.id ?? DEFAULT_AI_MODEL;

const CLASSIFY_TOOL_NAME = "classify_owner_message";

const SLOT_KEYS = Object.keys(MEMORY_SLOTS);

type OwnerIntent =
  | "memory_note"
  | "instruction"
  | "pin_request"
  | "reminder"
  | "scheduled_action"
  | "watch"
  | "acknowledgment"
  | "ordinary_reply";

interface ClassifiedOwnerMessage {
  intent: OwnerIntent;
  content?: string;
  customerHint?: string;
  slotKey?: string;
  triggerAt?: string;
  recurring?: boolean;
  /** scheduled_action only: recipient email, if the owner gave one explicitly rather than a name/hint. */
  recipientEmail?: string;
  /** scheduled_action only: the email subject line. */
  emailSubject?: string;
}

function buildClassifyTool(): LlmToolDefinition {
  return {
    name: CLASSIFY_TOOL_NAME,
    description: "Classify what the business owner is asking for in this message.",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: [
            "memory_note",
            "instruction",
            "pin_request",
            "reminder",
            "scheduled_action",
            "watch",
            "acknowledgment",
            "ordinary_reply",
          ],
          description: [
            "memory_note: the owner is telling you a fact to remember (about a specific customer, or about the business generally) — not a standing behavioral rule, just something to know.",
            "instruction: the owner is giving you a standing behavioral rule for how to act going forward (e.g. 'always mention our holiday hours', 'never offer discounts over 10%').",
            "pin_request: the owner is telling you to ALWAYS keep something in mind / never lose track of it / always surface it — stronger than memory_note, explicit about permanence (e.g. 'always remember Jane prefers phone calls', 'don't ever forget we're closed Fridays').",
            "reminder: the owner wants YOU to remind THEM of something at a specific future time — nothing gets sent to anyone else, this is purely a notification back to the owner.",
            "scheduled_action: the owner wants you to actually SEND AN EMAIL to someone else at a specific future time (e.g. 'send Jane an email tomorrow morning about the delay', 'email the Smiths Monday morning to confirm'). Distinct from reminder: this results in a real outbound email, not just a note back to the owner.",
            "watch: the owner wants to be notified specifically when a particular customer emails in.",
            "acknowledgment: a plain acknowledgment with no new request (thanks, ok, got it) and nothing else in the message.",
            "ordinary_reply: anything else — a question, a normal conversational message, a request that needs the full agent (checking the inbox, drafting an email, calendar actions, etc).",
          ].join(" "),
        },
        content: {
          type: "string",
          description: "For memory_note/instruction/pin_request/reminder: the actual fact/rule/reminder text, cleaned up as a standalone statement in your own words. For scheduled_action: the full email body, in your own words based on what the owner asked for. Omit for watch/acknowledgment/ordinary_reply.",
        },
        customerHint: {
          type: "string",
          description: "If this is about a specific customer, their name or email exactly as the owner referred to them. For scheduled_action, this is the recipient. Omit if this isn't about a specific customer.",
        },
        slotKey: {
          type: "string",
          enum: SLOT_KEYS,
          description: "If content is a structured value matching one of these known fields, name it here. Omit otherwise.",
        },
        triggerAt: {
          type: "string",
          description: "For reminder/scheduled_action ONLY: the resolved absolute date/time as an ISO 8601 datetime WITH a UTC offset, resolved against the current date/time context given to you and the business's own timezone. Required whenever intent is reminder or scheduled_action.",
        },
        recurring: {
          type: "boolean",
          description: "For watch ONLY: true if this should trigger every time this customer emails, false if just the next time.",
        },
        recipientEmail: {
          type: "string",
          description: "For scheduled_action ONLY, when the owner gave an explicit email address for the recipient rather than just a name. Omit if only a name/hint was given (use customerHint instead) or if intent isn't scheduled_action.",
        },
        emailSubject: {
          type: "string",
          description: "For scheduled_action ONLY: a concise subject line for the scheduled email, in your own words. Required whenever intent is scheduled_action.",
        },
      },
      required: ["intent"],
    },
  };
}

async function classifyOwnerMessage(
  message: string,
  timezone: string | null
): Promise<ClassifiedOwnerMessage | null> {
  if (!isProviderConfigured(CHEAP_PROVIDER)) {
    console.error("OWNER INTENT: classifier provider not configured");
    return null;
  }

  try {
    const result = await runChatCompletion(CHEAP_PROVIDER, {
      model: CHEAP_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "You classify a single message from a business owner to their AI email assistant.",
            buildCurrentDateContext(timezone ?? undefined),
            "You MUST report your answer using the classify_owner_message tool. When genuinely unsure between ordinary_reply and something else, prefer ordinary_reply — a false negative just means the normal assistant handles it; a false positive on memory_note/instruction/pin_request/reminder can create something wrong.",
          ].join("\n\n"),
        },
        {
          role: "user",
          content: message,
        },
      ],
      tools: [buildClassifyTool()],
    });

    const call = result.toolCalls.find((toolCall) => toolCall.name === CLASSIFY_TOOL_NAME);
    if (!call) return null;

    const parsed = JSON.parse(call.arguments || "{}");

    if (typeof parsed.intent !== "string") return null;

    return parsed as ClassifiedOwnerMessage;
  } catch (error) {
    console.error("OWNER INTENT: classification failed:", error);
    return null;
  }
}

type CustomerResolution =
  | { status: "none" }
  | { status: "resolved"; email: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "not_found" };

/**
 * Silent when there's exactly one match, a soft-confirm when there are
 * several, and an ask-for-detail when there are none — per the plan's
 * "ambiguity resolution scales with actual uncertainty" principle.
 */
async function resolveCustomerReference(
  tenantId: string,
  hint: string | undefined
): Promise<CustomerResolution> {
  if (!hint || !hint.trim()) {
    return { status: "none" };
  }

  const trimmed = hint.trim();

  if (trimmed.includes("@")) {
    return { status: "resolved", email: extractEmailAddress(trimmed) };
  }

  const supabase = createServiceSupabase();
  const needle = trimmed.toLowerCase();

  const [emailActionsResult, preferredNameResult] = await Promise.all([
    supabase
      .from("email_actions")
      .select("customer_email")
      .eq("tenant_id", tenantId)
      .not("customer_email", "is", null)
      .limit(500),
    supabase
      .from("agent_memories")
      .select("customer_email, content")
      .eq("tenant_id", tenantId)
      .eq("scope", "customer")
      .eq("slot_key", "preferred_name")
      .is("superseded_by", null)
      .ilike("content", `%${trimmed}%`),
  ]);

  const candidates = new Set<string>();

  for (const row of emailActionsResult.data ?? []) {
    const email = row.customer_email;
    if (email && email.split("@")[0].toLowerCase().includes(needle)) {
      candidates.add(email);
    }
  }

  for (const row of preferredNameResult.data ?? []) {
    if (row.customer_email) candidates.add(row.customer_email);
  }

  const list = Array.from(candidates);

  if (list.length === 0) return { status: "not_found" };
  if (list.length === 1) return { status: "resolved", email: list[0] };
  return { status: "ambiguous", candidates: list.slice(0, 5) };
}

export interface ParseOwnerMessageInput {
  tenantId: string;
  message: string;
  timezone: string | null;
  sourceThreadId?: string | null;
}

export async function parseOwnerMessage(
  input: ParseOwnerMessageInput
): Promise<OwnerIntentResult> {
  const classified = await classifyOwnerMessage(input.message, input.timezone);

  if (!classified || classified.intent === "ordinary_reply") {
    return { handled: false };
  }

  switch (classified.intent) {
    case "acknowledgment": {
      const resolved = await checkAndResolveAcknowledgment(input.tenantId, input.message);

      if (!resolved) {
        // Nothing to resolve — just a normal "thanks," let the usual
        // pipeline reply naturally.
        return { handled: false };
      }

      return {
        handled: true,
        responseText: `Got it — cleared that reminder: "${resolved.content}"`,
      };
    }

    case "watch": {
      return {
        handled: true,
        responseText:
          "I can't set up per-customer watches yet — that's still being built. For now I can remember things, follow standing instructions, and set reminders.",
      };
    }

    case "instruction": {
      const content = classified.content?.trim();

      if (!content) {
        return { handled: false };
      }

      const supabase = createServiceSupabase();

      const { error } = await supabase.from("agent_instruction_notes").insert({
        tenant_id: input.tenantId,
        content,
        source_thread_id: input.sourceThreadId ?? null,
        active: true,
      });

      if (error) {
        console.error("OWNER INTENT: failed to save instruction:", error);
        return {
          handled: true,
          responseText: "Something went wrong saving that instruction — mind trying again?",
        };
      }

      return {
        handled: true,
        responseText: `Got it — I'll keep this in mind going forward: "${content}"`,
      };
    }

    case "memory_note":
    case "pin_request": {
      const content = classified.content?.trim();

      if (!content) {
        return { handled: false };
      }

      const resolution = await resolveCustomerReference(input.tenantId, classified.customerHint);

      if (resolution.status === "ambiguous") {
        return {
          handled: true,
          responseText: `A few customers match "${classified.customerHint}" — which one did you mean? ${resolution.candidates.join(", ")}`,
        };
      }

      if (resolution.status === "not_found") {
        return {
          handled: true,
          responseText: `I couldn't find a customer matching "${classified.customerHint}" — can you give me their email address?`,
        };
      }

      const isPin = classified.intent === "pin_request";
      const slotKey =
        classified.slotKey && isKnownSlotKey(classified.slotKey) ? classified.slotKey : null;

      const written = await writeMemory({
        tenantId: input.tenantId,
        scope: resolution.status === "resolved" ? "customer" : "tenant",
        customerEmail: resolution.status === "resolved" ? resolution.email : null,
        content,
        source: "owner_stated",
        sourceThreadId: input.sourceThreadId ?? null,
        slotKey,
        alwaysSurface: isPin,
        pinSource: isPin ? "owner" : null,
      });

      if (!written) {
        return {
          handled: true,
          responseText: "Something went wrong saving that — mind trying again?",
        };
      }

      const scopeDescription =
        resolution.status === "resolved" ? ` for ${resolution.email}` : "";

      return {
        handled: true,
        responseText: isPin
          ? `Got it — I'll always keep this in mind${scopeDescription}: "${content}"`
          : `Noted${scopeDescription}: "${content}"`,
      };
    }

    case "reminder": {
      const content = classified.content?.trim();

      if (!content) {
        return { handled: false };
      }

      if (!classified.triggerAt) {
        return {
          handled: true,
          responseText: "When should I remind you? Give me a specific day/time.",
        };
      }

      let relatedCustomerEmail: string | null = null;

      if (classified.customerHint) {
        const resolution = await resolveCustomerReference(input.tenantId, classified.customerHint);
        if (resolution.status === "resolved") {
          relatedCustomerEmail = resolution.email;
        }
        // Ambiguous/not_found: proceed without linking a customer rather
        // than blocking the reminder itself — an imperfectly-linked
        // reminder is a much smaller problem than one that never gets
        // created because a name didn't resolve cleanly.
      }

      const result = await createReminder({
        tenantId: input.tenantId,
        content,
        triggerAt: classified.triggerAt,
        relatedCustomerEmail,
        sourceThreadId: input.sourceThreadId ?? null,
      });

      if ("error" in result) {
        return { handled: true, responseText: result.error };
      }

      const when = new Date(result.triggerAt).toLocaleString("en-US", {
        timeZone: input.timezone ?? "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      });

      return {
        handled: true,
        responseText: `Got it — I'll remind you: "${content}" (${when}).`,
      };
    }

    case "scheduled_action": {
      const content = classified.content?.trim();
      const emailSubject = classified.emailSubject?.trim();

      if (!content || !emailSubject) {
        return { handled: false };
      }

      if (!classified.triggerAt) {
        return {
          handled: true,
          responseText: "When should I send it? Give me a specific day/time.",
        };
      }

      let recipientEmail = classified.recipientEmail?.trim();

      if (!recipientEmail) {
        const resolution = await resolveCustomerReference(input.tenantId, classified.customerHint);

        if (resolution.status === "resolved") {
          recipientEmail = resolution.email;
        } else if (resolution.status === "ambiguous") {
          return {
            handled: true,
            responseText: `A few customers match "${classified.customerHint}" — which one did you mean? ${resolution.candidates.join(", ")}`,
          };
        } else {
          return {
            handled: true,
            responseText: `Who should I send this to? Give me their email address (I couldn't find a match for "${classified.customerHint ?? ""}").`,
          };
        }
      }

      const result = await createScheduledEmailAction({
        tenantId: input.tenantId,
        toEmail: recipientEmail,
        subject: emailSubject,
        body: content,
        triggerAt: classified.triggerAt,
        sourceThreadId: input.sourceThreadId ?? null,
      });

      if ("error" in result) {
        return { handled: true, responseText: result.error };
      }

      const when = new Date(result.triggerAt).toLocaleString("en-US", {
        timeZone: input.timezone ?? "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      });

      // Phrase the confirmation honestly based on whether sending is
      // actually authorized right now — checked again for real at fire
      // time (see lib/agent/scheduled-actions/dispatch.ts), this is just
      // to avoid promising an auto-send that won't actually happen.
      const capability = await resolveSendCapability(input.tenantId);

      const willAutoSend = capability === "send";

      return {
        handled: true,
        responseText: willAutoSend
          ? `Got it — I'll send that email to ${recipientEmail} (subject: "${emailSubject}") on ${when}.`
          : `Got it — I've scheduled that email to ${recipientEmail} (subject: "${emailSubject}") for ${when}. Sending isn't currently enabled, so I'll save it as a Gmail draft at that time instead of sending it automatically.`,
      };
    }

    default:
      return { handled: false };
  }
}
