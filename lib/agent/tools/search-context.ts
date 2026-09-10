import type { ToolContext, ToolDefinition } from "./types";
import { searchContext } from "@/lib/agent/memory/search-context";
import { extractEmailAddress } from "@/lib/agent/memory/util";

/**
 * Tier 2 of the memory retrieval model (build plan section 0.1) — the
 * agent's own on-demand lookup, replacing the original plan's "auto-
 * inject top 8 memories into every email" design. Consequential slots,
 * pinned memories, and owner instructions already ride along on every
 * relevant task for free (see lib/agent/memory/pinned.ts, wired into the
 * system prompt in run.ts/chat.ts) — this tool is for everything else:
 * freeform customer history and business knowledge, fetched only when
 * the agent judges the current task actually needs it.
 *
 * Deliberately a BASELINE tool: capability "memory" is always in the
 * router's available/active capability set (see
 * lib/agent/router/types.ts's BASELINE_CAPABILITIES and
 * lib/agent/router/index.ts's deriveAvailableCapabilities), so the
 * capability pre-router never narrows it away the way it might narrow
 * calendar/zoom for a routine email — there's no permission gate on a
 * read-only, tenant/customer-scoped lookup like this, so there's no
 * reason to ever withhold it.
 */
export const searchContextTool: ToolDefinition = {
  name: "search_context",

  description:
    "Search this business's stored knowledge and this customer's memory for anything relevant to the current task. Use this whenever a reply might depend on prior context — a past preference, a previous issue, a specific business policy or fact not already given to you — rather than answering from assumption. Returns a tagged list: business_knowledge results are owner-curated facts about the business; customer_memory results are things learned from past conversations with this specific customer (each carries whether it's verified — treat an unverified detail as something to confirm, not to act on directly). Cheap and safe to call — read-only, and calling it when nothing turns out to be relevant costs nothing but a quick lookup.",

  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for, in plain language (e.g. 'shipping policy for international orders', 'has this customer mentioned a delivery issue before').",
      },
      customerEmail: {
        type: "string",
        description:
          "The customer's email address to scope the customer-memory search to. On the email surface this defaults to the current thread's sender if omitted — only set it to look up a DIFFERENT customer than the one currently being replied to. On the chat surface (owner conversation), set this whenever the owner is asking about a specific customer by name/email.",
      },
      scope: {
        type: "string",
        enum: ["memory", "knowledge", "both"],
        description: "Narrow the search to just customer memory, just business knowledge, or both (default: both).",
      },
    },
    required: ["query"],
  },

  surfaces: ["email", "chat"],
  capability: "memory",

  isAvailable: () => true,

  terminal: false,

  async execute(args: Record<string, any>, context: ToolContext) {
    const query = typeof args.query === "string" ? args.query.trim() : "";

    if (!query) {
      throw new Error("search_context requires a non-empty query");
    }

    const explicitCustomerEmail =
      typeof args.customerEmail === "string" && args.customerEmail.trim()
        ? extractEmailAddress(args.customerEmail)
        : null;

    const defaultCustomerEmail = context.email?.from
      ? extractEmailAddress(context.email.from)
      : null;

    const customerEmail = explicitCustomerEmail ?? defaultCustomerEmail;

    const scope =
      args.scope === "memory" || args.scope === "knowledge" || args.scope === "both"
        ? args.scope
        : "both";

    const results = await searchContext({
      tenantId: context.tenantId,
      customerEmail,
      query,
      scope,
    });

    return {
      success: true,
      action: "context_searched",
      query,
      customerEmail,
      count: results.length,
      results,
      message:
        results.length === 0
          ? "Nothing relevant found. Do not assume this means nothing exists — it means nothing matched this specific query well enough; consider rephrasing if you expected a result."
          : `Found ${results.length} relevant item(s) — see \`results\`. Treat business_knowledge as established fact; treat customer_memory with verified: false as something to confirm before relying on it.`,
    };
  },
};
