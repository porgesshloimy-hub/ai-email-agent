import { runChatCompletion, isProviderConfigured } from "@/lib/agent/llm";
import type { LlmToolDefinition } from "@/lib/agent/llm";
import { MODEL_CATALOG, DEFAULT_AI_MODEL } from "@/lib/agent/models";
import type { AIProvider } from "@/lib/agent/models";

import { writeMemory } from "./write";
import { MEMORY_SLOTS, isKnownSlotKey } from "./slots";

/**
 * Cheap-model structured-output call that reads one finished email
 * exchange and pulls out any durable customer/business facts worth
 * remembering, split into slot updates (a value for a known named field
 * — see slots.ts) and freeform notes (anything else worth keeping that
 * doesn't fit a slot).
 *
 * Same "independent of the tenant's chosen chat model, always the
 * cheapest configured OpenAI tier" pattern as
 * lib/agent/router/classifier.ts, and the same fail-open posture: any
 * failure here (missing key, bad response, network error) is logged and
 * swallowed. This must never throw into or block the send path that
 * calls it — see lib/agent/run.ts's post-send hook, which calls this
 * fire-and-forget.
 *
 * Deliberately does NOT take an `existingMemories` list to steer the
 * model away from re-extracting known facts — write.ts's own dedup
 * (freeform notes) and overwrite-in-place (slots) already make a
 * redundant extraction harmless rather than needing the prompt to avoid
 * it in the first place. Keeps this call's prompt small and avoids
 * re-fetching + re-serializing a tenant's whole memory set on every
 * single email just to prevent a no-op write.
 */

const cheapestOpenAiModel = MODEL_CATALOG.openai.models.find(
  (model) => model.tier === "Cheapest"
);

const EXTRACTOR_PROVIDER: AIProvider = "openai";
const EXTRACTOR_MODEL: string = cheapestOpenAiModel?.id ?? DEFAULT_AI_MODEL;

const RECORD_TOOL_NAME = "record_memories";

const SLOT_KEYS = Object.keys(MEMORY_SLOTS);

function buildRecordTool(): LlmToolDefinition {
  return {
    name: RECORD_TOOL_NAME,
    description:
      "Report any durable customer or business facts worth remembering from this email exchange. Only report something clearly stated by the customer or unambiguous from context — never guess or infer beyond what's actually said.",
    parameters: {
      type: "object",
      properties: {
        slots: {
          type: "array",
          description:
            "Structured values for known fields. Only include a slot if its value was actually stated in this exchange.",
          items: {
            type: "object",
            properties: {
              slotKey: {
                type: "string",
                enum: SLOT_KEYS,
              },
              value: {
                type: "string",
                description: "The stated value, as a short plain string (e.g. the address itself, the phone number itself).",
              },
            },
            required: ["slotKey", "value"],
          },
        },
        notes: {
          type: "array",
          description:
            "Freeform facts worth remembering that don't fit a known slot (a stated preference, a recurring complaint, context about their business, anything that would help a future reply). Each entry should be a short, self-contained sentence. Empty array if nothing is worth noting.",
          items: { type: "string" },
        },
      },
      required: ["slots", "notes"],
    },
  };
}

export interface RunMemoryExtractionInput {
  tenantId: string;
  customerEmail: string;
  sourceThreadId?: string | null;
  emailSubject: string;
  emailBody: string;
  /** The reply the agent sent or drafted, if any — gives the extractor the full exchange rather than just the inbound half. */
  agentReplyText?: string | null;
}

export async function runMemoryExtraction(
  input: RunMemoryExtractionInput
): Promise<void> {
  try {
    if (!isProviderConfigured(EXTRACTOR_PROVIDER)) {
      console.error(
        "MEMORY EXTRACTION: provider not configured, skipping",
        { provider: EXTRACTOR_PROVIDER }
      );
      return;
    }

    const tool = buildRecordTool();

    const result = await runChatCompletion(EXTRACTOR_PROVIDER, {
      model: EXTRACTOR_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "You read one finished customer email exchange for a business and extract durable facts worth remembering for future conversations with this same customer.",
            "Only extract what was actually said — never invent or infer a fact beyond what's explicitly stated.",
            "You MUST report your answer using the record_memories tool, even if both lists end up empty.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Customer email subject: ${input.emailSubject}`,
            `Customer email body: ${input.emailBody}`,
            input.agentReplyText
              ? `Business's reply: ${input.agentReplyText}`
              : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      tools: [tool],
    });

    const call = result.toolCalls.find(
      (toolCall) => toolCall.name === RECORD_TOOL_NAME
    );

    if (!call) {
      console.log("MEMORY EXTRACTION: model did not call record_memories, nothing to extract", {
        tenantId: input.tenantId,
        customerEmail: input.customerEmail,
      });
      return;
    }

    let parsed: { slots?: unknown; notes?: unknown };

    try {
      parsed = JSON.parse(call.arguments || "{}");
    } catch (parseError) {
      console.error("MEMORY EXTRACTION: invalid JSON from model:", parseError);
      return;
    }

    const slots = Array.isArray(parsed.slots) ? parsed.slots : [];
    const notes = Array.isArray(parsed.notes) ? parsed.notes : [];

    for (const slot of slots) {
      if (
        !slot ||
        typeof slot !== "object" ||
        typeof (slot as any).slotKey !== "string" ||
        typeof (slot as any).value !== "string" ||
        !(slot as any).value.trim()
      ) {
        continue;
      }

      const slotKey = (slot as any).slotKey as string;

      if (!isKnownSlotKey(slotKey)) {
        console.error("MEMORY EXTRACTION: model reported an unknown slot key, skipping:", slotKey);
        continue;
      }

      await writeMemory({
        tenantId: input.tenantId,
        scope: "customer",
        customerEmail: input.customerEmail,
        content: (slot as any).value.trim(),
        source: "extracted",
        sourceThreadId: input.sourceThreadId ?? null,
        slotKey,
      });
    }

    for (const note of notes) {
      if (typeof note !== "string" || !note.trim()) continue;

      await writeMemory({
        tenantId: input.tenantId,
        scope: "customer",
        customerEmail: input.customerEmail,
        content: note.trim(),
        source: "extracted",
        sourceThreadId: input.sourceThreadId ?? null,
      });
    }

    console.log("MEMORY EXTRACTION complete:", {
      tenantId: input.tenantId,
      customerEmail: input.customerEmail,
      slotsWritten: slots.length,
      notesWritten: notes.length,
    });
  } catch (error) {
    // Fails open — see module comment. Never let extraction errors
    // surface to the caller.
    console.error("MEMORY EXTRACTION failed:", error, {
      tenantId: input.tenantId,
      customerEmail: input.customerEmail,
    });
  }
}
