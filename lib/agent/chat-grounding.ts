import { runChatCompletion, isProviderConfigured } from "@/lib/agent/llm";
import type { LlmMessage, LlmToolDefinition, LlmUsage } from "@/lib/agent/llm";
import { MODEL_CATALOG, DEFAULT_AI_MODEL } from "@/lib/agent/models";
import type { AIProvider } from "@/lib/agent/models";

/**
 * ------------------------------------------------------------
 * Owner-chat reply grounding
 * ------------------------------------------------------------
 *
 * The email path has had a grounding guard (lib/agent/grounding-guard.ts)
 * since an agent described a Zoom meeting as booked when nothing had
 * been booked. The owner chat had nothing equivalent: whenever the
 * model stopped calling tools, whatever text it wrote went straight to
 * the owner — so "I'm setting it now", "noted", "done" could be said
 * over nothing, and were.
 *
 * This is the same principle applied here: the model is never the
 * authority on whether an action happened. After the model writes its
 * final reply, a small cheap model compares the reply against the
 * actual tool calls and tool RESULTS from this turn — the only evidence
 * that anything was done — and flags any claim or promise of action
 * nothing backs. If something is flagged, the agent is sent back to
 * either do it (it has the tools) or correct itself; if it still can't,
 * the owner gets an honest correction instead of the false confirmation.
 *
 * Skipped for replies that don't read like they claim any action, so
 * ordinary Q&A costs nothing extra.
 *
 * If the check itself can't run, the reply is NOT silently trusted and
 * NOT withheld: it is sent with an explicit note that it couldn't be
 * double-checked — failing safe toward honesty rather than toward
 * either blind trust or silence.
 */

export const CHAT_GROUNDING_PROVIDER: AIProvider = "openai";

const cheapestOpenAiModel = MODEL_CATALOG.openai.models.find((model) => model.tier === "Cheapest");

export const CHAT_GROUNDING_MODEL: string = cheapestOpenAiModel?.id ?? DEFAULT_AI_MODEL;

const REPORT_TOOL_NAME = "report_unsupported_claims";

/** One tool call from this turn and what it actually returned. */
export interface ToolTranscriptEntry {
  tool: string;
  args: string;
  result: string;
}

export interface UnsupportedClaim {
  claim: string;
  reason: string;
}

export interface ChatGroundingResult {
  /** True when the reply is safe to send as written. */
  ok: boolean;
  unsupported: UnsupportedClaim[];
  /**
   * "skipped": the reply doesn't read like it claims any action.
   * "judge": the check ran. "judge_unavailable": it could not run.
   */
  source: "skipped" | "judge" | "judge_unavailable";
  error?: string;
}

/**
 * A cheap, deterministic first gate: does the reply read like it claims
 * — or promises — that something was done? Deliberately broad. It only
 * decides whether to spend the checking call; it never decides that a
 * reply is wrong. "I'll …" and "I'm …ing" are included on purpose:
 * promising an action that nothing performs ("I'll keep that in mind",
 * "I'm setting it now") is exactly the original failure.
 */
const ACTION_CLAIM_PATTERN = new RegExp(
  [
    "\\bi['’]ll\\b",
    "\\bi will\\b",
    "\\bi['’]m (?:\\w+ing|on it|going to)\\b",
    "\\bi am (?:\\w+ing|going to)\\b",
    "\\bi['’]ve\\b",
    "\\bi have\\b",
    "\\bgot it\\b",
    "\\bon it\\b",
    "\\ball set\\b",
    "\\bnoted\\b",
    "\\bwill (?:be|remind|send|keep|do|set|save)\\b",
    "\\b(?:done|saved|set|scheduled|created|cancell?ed|deleted|removed|sent|drafted|booked|added|updated|marked|cleared|handled|pinned|forwarded|remembered|reminded|stored|recorded|queued)\\b",
    "\\bis (?:now )?(?:set|saved|scheduled|on your)\\b",
  ].join("|"),
  "i"
);

export function looksLikeActionClaim(reply: string): boolean {
  return ACTION_CLAIM_PATTERN.test(reply);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatTranscript(transcript: ToolTranscriptEntry[]): string {
  if (transcript.length === 0) return "(no tools were called this turn)";

  return transcript
    .map(
      (entry, index) =>
        `${index + 1}. ${entry.tool}(${truncate(entry.args, 300)})\n   RESULT: ${truncate(entry.result, 700)}`
    )
    .join("\n");
}

function buildReportTool(): LlmToolDefinition {
  return {
    name: REPORT_TOOL_NAME,
    description:
      "Report every statement in the draft reply that claims or promises an action nothing in the tool results supports. Report an empty array if there are none.",
    parameters: {
      type: "object",
      properties: {
        violations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string", description: "The specific sentence or phrase in the draft making the unsupported claim." },
              reason: { type: "string", description: "Briefly: why the tool results don't support it (no tool was called, the tool failed, the details differ, …)." },
            },
            required: ["claim", "reason"],
          },
        },
      },
      required: ["violations"],
    },
  };
}

export interface GroundingDeps {
  run?: typeof runChatCompletion;
  isConfigured?: (provider: AIProvider) => boolean;
  onUsage?: (usage: LlmUsage | null) => Promise<void> | void;
}

export async function checkChatReplyGrounding(
  input: { ownerMessage: string; reply: string; transcript: ToolTranscriptEntry[] },
  deps: GroundingDeps = {}
): Promise<ChatGroundingResult> {
  const { ownerMessage, reply, transcript } = input;
  const run = deps.run ?? runChatCompletion;
  const isConfigured = deps.isConfigured ?? isProviderConfigured;

  if (!reply.trim() || !looksLikeActionClaim(reply)) {
    return { ok: true, unsupported: [], source: "skipped" };
  }

  const unavailable = (error: string): ChatGroundingResult => {
    console.error("CHAT GROUNDING CHECK COULD NOT RUN — reply will carry a caveat:", { error });
    return { ok: false, unsupported: [], source: "judge_unavailable", error };
  };

  if (!isConfigured(CHAT_GROUNDING_PROVIDER)) {
    return unavailable(`provider "${CHAT_GROUNDING_PROVIDER}" is not configured`);
  }

  try {
    const result = await run(CHAT_GROUNDING_PROVIDER, {
      model: CHAT_GROUNDING_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "You are a fact-checking pass on an AI assistant's reply to its owner, run just before the reply is sent.",
            "You are given: the owner's latest message; the exact tool calls the assistant made THIS turn together with their RESULTS (the only evidence that anything was actually done); and the assistant's draft reply.",
            "Flag every statement in the draft that claims or promises an action — set, saved, scheduled, sent, drafted, created, cancelled, deleted, removed, marked done, added, updated, remembered, noted, 'I'll keep that in mind', 'I'm setting it now', 'I'll remind you' — where no SUCCESSFUL tool result in the transcript backs it.",
            "A tool result that says it failed, was NOT saved, could not be done, could not be verified, or asks for clarification does NOT back a claim of success. Also flag a claim whose details contradict what the tool actually recorded (a different time, recipient, or content).",
            "Also flag statements about the CURRENT state of the owner's saved items (e.g. 'your reminder is set for 4 PM', 'nothing is scheduled') when no tool result this turn looked that up — earlier conversation can be stale or wrong.",
            "Do NOT flag: information read from tools and reported accurately; offers or questions ('want me to set a reminder?'); statements that something was NOT done or could not be done; descriptions of what the assistant is able to do in general; ordinary conversation; things the OWNER said.",
            "Be precise and quote the claim. You MUST answer by calling the report_unsupported_claims tool; report an empty array if everything is supported.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Owner's message:\n${ownerMessage}`,
            `Tool calls this turn and their results:\n${formatTranscript(transcript)}`,
            `Draft reply:\n${reply}`,
          ].join("\n\n"),
        },
      ],
      tools: [buildReportTool()],
    });

    if (deps.onUsage) {
      try {
        await deps.onUsage(result.usage);
      } catch (error) {
        console.error("CHAT GROUNDING: failed to meter usage:", error);
      }
    }

    const call = result.toolCalls.find((toolCall) => toolCall.name === REPORT_TOOL_NAME);

    if (!call) {
      return unavailable("the checking model did not report a result");
    }

    const parsed = JSON.parse(call.arguments || "{}");

    if (!Array.isArray(parsed.violations)) {
      return unavailable("the checking model returned a malformed result");
    }

    const unsupported: UnsupportedClaim[] = parsed.violations
      .filter((v: any) => v && typeof v.claim === "string" && v.claim.trim())
      .map((v: any) => ({ claim: String(v.claim).trim(), reason: String(v.reason ?? "").trim() }));

    return { ok: unsupported.length === 0, unsupported, source: "judge" };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** What happens in one pass of the model's tool loop. */
export interface TurnOutcome {
  text: string;
  /**
   * False for text that is already grounded by construction (a tool
   * holding for owner confirmation, a clean error message, the
   * step-limit message) — there is no model-written claim to check.
   */
  verify: boolean;
  /** The conversation so far, for sending the model back with a correction. */
  messages: LlmMessage[];
}

export const MAX_CORRECTION_ROUNDS = 2;

export function buildCorrectionMessage(unsupported: UnsupportedClaim[]): string {
  return [
    "VERIFICATION FAILED. Checking your draft reply against the actual tool results from this turn found claims that nothing backs:",
    ...unsupported.map((u) => `- "${u.claim}"${u.reason ? ` — ${u.reason}` : ""}`),
    "Do not repeat those claims. If the owner's request still needs doing, do it now by calling the right tool, then tell the owner only what the tool results actually show. If you can't do it, tell the owner plainly that it was NOT done and why. Write your corrected reply now.",
  ].join("\n");
}

/** Used when the agent still can't produce a grounded reply after being sent back. */
export function buildHonestFallback(unsupported: UnsupportedClaim[]): string {
  const quoted = unsupported
    .slice(0, 3)
    .map((u) => `"${u.claim}"`)
    .join("; ");

  return `I need to correct myself — I said something I can't actually back up (${quoted}). Please don't rely on it: nothing I can verify was saved or changed. Tell me again and I'll try once more.`;
}

export const UNVERIFIED_CAVEAT =
  "\n\n(Note: I couldn't double-check that everything I just described actually went through.)";

/**
 * Checks the model's reply against what really happened, sends the
 * model back to fix it when it doesn't match, and — if it still can't
 * produce a reply the evidence supports — replaces it with an honest
 * correction. Pure orchestration: the model loop and the check are
 * passed in, so the control flow is testable on its own.
 */
export async function verifyAndCorrect(options: {
  first: TurnOutcome;
  runAgain: (messages: LlmMessage[]) => Promise<TurnOutcome>;
  check: (reply: string) => Promise<ChatGroundingResult>;
  maxRounds?: number;
}): Promise<string> {
  const maxRounds = options.maxRounds ?? MAX_CORRECTION_ROUNDS;
  let current = options.first;

  for (let round = 0; ; round++) {
    if (!current.verify) return current.text;

    const result = await options.check(current.text);

    if (result.ok) return current.text;

    if (result.source === "judge_unavailable") {
      return current.text + UNVERIFIED_CAVEAT;
    }

    console.error("CHAT GROUNDING: reply made claims the tool results don't support:", {
      round,
      unsupported: result.unsupported,
    });

    if (round >= maxRounds) {
      return buildHonestFallback(result.unsupported);
    }

    current = await options.runAgain([
      ...current.messages,
      { role: "assistant", content: current.text },
      { role: "user", content: buildCorrectionMessage(result.unsupported) },
    ]);
  }
}
