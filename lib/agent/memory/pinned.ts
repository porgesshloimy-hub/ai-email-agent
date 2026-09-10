import { createServiceSupabase } from "@/lib/supabase/server";
import { CONSEQUENTIAL_SLOT_KEYS } from "./slots";
import type { AgentMemoryRow } from "./write";

/**
 * Tier 1 of the memory retrieval model (see the project's memory-system
 * build plan, section 0.1) — a small, deterministic set that rides along
 * on every relevant task with no embedding call and no similarity
 * ranking: consequential slots, anything explicitly flagged
 * always_surface, and active owner instruction notes. Everything else
 * (freeform notes, most customer history, business knowledge) is Tier 2
 * — reached only via the agent-invoked search_context tool, see
 * search-context.ts.
 *
 * If this ever needs a cap to stay reasonable, that's a signal the
 * pinned tier is being over-used — flag it rather than just raising a
 * limit here.
 */

export interface PinnedInstructionNote {
  id: string;
  content: string;
}

export interface PinnedContext {
  /** Consequential slots for this customer (shipping_address, phone_number, etc.) — auto-pinned, no owner action needed. */
  consequentialSlots: AgentMemoryRow[];
  /** Rows (tenant- or customer-scope) explicitly flagged always_surface, owner-set or owner-approved-suggested. */
  pinnedMemories: AgentMemoryRow[];
  /** Active agent_instruction_notes for this tenant. */
  instructionNotes: PinnedInstructionNote[];
}

/**
 * Tenant-scope pins always apply; customer-scope pins only apply when
 * they belong to this specific customer. Run as two plain `.eq()`
 * queries and merged in JS rather than a single `.or()` filter string —
 * a customerEmail containing a comma or parenthesis would otherwise
 * corrupt PostgREST's filter syntax.
 */
async function fetchPinnedMemories(
  supabase: ReturnType<typeof createServiceSupabase>,
  tenantId: string,
  customerEmail: string | null
): Promise<{ data: AgentMemoryRow[] | null; error: unknown }> {
  const tenantScopeQuery = supabase
    .from("agent_memories")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("scope", "tenant")
    .eq("always_surface", true)
    .is("superseded_by", null);

  if (!customerEmail) {
    const { data, error } = await tenantScopeQuery;
    return { data: data as AgentMemoryRow[] | null, error };
  }

  const customerScopeQuery = supabase
    .from("agent_memories")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("scope", "customer")
    .eq("customer_email", customerEmail)
    .eq("always_surface", true)
    .is("superseded_by", null);

  const [tenantResult, customerResult] = await Promise.all([
    tenantScopeQuery,
    customerScopeQuery,
  ]);

  return {
    data: [
      ...((tenantResult.data ?? []) as AgentMemoryRow[]),
      ...((customerResult.data ?? []) as AgentMemoryRow[]),
    ],
    error: tenantResult.error ?? customerResult.error,
  };
}

export async function fetchPinnedContext(
  tenantId: string,
  customerEmail: string | null
): Promise<PinnedContext> {
  const supabase = createServiceSupabase();

  const [slotsResult, pinnedResult, notesResult] = await Promise.all([
    customerEmail
      ? supabase
          .from("agent_memories")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("scope", "customer")
          .eq("customer_email", customerEmail)
          .eq("is_consequential", true)
          .is("superseded_by", null)
      : Promise.resolve({ data: [], error: null }),

    fetchPinnedMemories(supabase, tenantId, customerEmail),

    supabase
      .from("agent_instruction_notes")
      .select("id, content")
      .eq("tenant_id", tenantId)
      .eq("active", true),
  ]);

  if (slotsResult.error) {
    console.error("PINNED CONTEXT: consequential-slot lookup failed:", slotsResult.error);
  }
  if (pinnedResult.error) {
    console.error("PINNED CONTEXT: always_surface lookup failed:", pinnedResult.error);
  }
  if (notesResult.error) {
    console.error("PINNED CONTEXT: instruction-notes lookup failed:", notesResult.error);
  }

  return {
    consequentialSlots: (slotsResult.data ?? []) as AgentMemoryRow[],
    pinnedMemories: (pinnedResult.data ?? []) as AgentMemoryRow[],
    instructionNotes: (notesResult.data ?? []) as PinnedInstructionNote[],
  };
}

/**
 * Renders a PinnedContext into the plain-text block the system prompt
 * assembly in run.ts/chat.ts drops into <pinned_context> — kept here
 * (next to where the data is fetched) rather than duplicated at each
 * call site.
 */
export function renderPinnedContext(context: PinnedContext): string {
  const lines: string[] = [];

  for (const slot of context.consequentialSlots) {
    lines.push(`- [${slot.slot_key}] ${slot.content}${slot.verified ? "" : " (unconfirmed — do not use this in an action without confirming it first)"}`);
  }

  for (const memory of context.pinnedMemories) {
    if (memory.is_slot) continue; // already covered by consequentialSlots if it's also consequential
    lines.push(`- ${memory.content}`);
  }

  return lines.join("\n");
}

export interface MemoryExistenceSignal {
  count: number;
  lastUsedAt: string | null;
}

/**
 * Cheap, content-free nudge: how many memory entries exist for this
 * customer and how recently one was touched. No embedding call, no
 * content returned — just enough for the agent to have a concrete,
 * factual reason to call search_context rather than having to guess
 * whether there's anything to find. See the build plan's "Closing the
 * 'wouldn't think to search' gap" section for why this exists alongside
 * (not instead of) the pinned tier above.
 */
export async function fetchMemoryExistenceSignal(
  tenantId: string,
  customerEmail: string | null
): Promise<MemoryExistenceSignal> {
  if (!customerEmail) {
    return { count: 0, lastUsedAt: null };
  }

  const supabase = createServiceSupabase();

  const { count, error: countError } = await supabase
    .from("agent_memories")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("scope", "customer")
    .eq("customer_email", customerEmail)
    .is("superseded_by", null);

  if (countError) {
    console.error("MEMORY EXISTENCE SIGNAL: count query failed:", countError);
    return { count: 0, lastUsedAt: null };
  }

  if (!count) {
    return { count: 0, lastUsedAt: null };
  }

  const { data: mostRecent, error: recentError } = await supabase
    .from("agent_memories")
    .select("last_used_at")
    .eq("tenant_id", tenantId)
    .eq("scope", "customer")
    .eq("customer_email", customerEmail)
    .is("superseded_by", null)
    .order("last_used_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentError) {
    console.error("MEMORY EXISTENCE SIGNAL: recency query failed:", recentError);
  }

  return {
    count,
    lastUsedAt: mostRecent?.last_used_at ?? null,
  };
}

/**
 * One-line, content-free rendering of the existence signal for the
 * system prompt (e.g. "This customer has 4 prior memory entries, last
 * updated 3 days ago."). Returns an empty string when count is 0 so
 * callers can drop the line entirely rather than stating "0 entries."
 */
export function renderExistenceSignal(signal: MemoryExistenceSignal): string {
  if (signal.count === 0) return "";

  const recencyPart = signal.lastUsedAt
    ? ` (last updated ${describeRecency(signal.lastUsedAt)})`
    : "";

  return `This customer has ${signal.count} prior memory ${
    signal.count === 1 ? "entry" : "entries"
  } on file${recencyPart}. If anything about this task could depend on prior context (preferences, past commitments, an ongoing issue), call search_context before responding.`;
}

function describeRecency(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24));

  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}
