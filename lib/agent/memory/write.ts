import { createServiceSupabase } from "@/lib/supabase/server";
import { generateEmbedding, cosineSimilarity } from "./util";
import { isKnownSlotKey, isConsequentialSlot } from "./slots";

/**
 * Single entry point for every memory write in the system — extraction
 * (extractor.ts), owner-stated instructions/pins (owner-intent.ts, a
 * later phase), and customer-stated facts all funnel through here so the
 * slot-overwrite-vs-note, dedup, and pin logic lives in exactly one
 * place. No tool calls this directly; see each caller's own module
 * comment for why.
 */

export type MemoryScope = "tenant" | "customer";
export type MemorySource = "extracted" | "owner_stated" | "customer_stated";
export type PinSource = "owner" | "suggested";

export interface WriteMemoryInput {
  tenantId: string;
  scope: MemoryScope;
  /** Required when scope is "customer"; ignored (stored as null) when scope is "tenant". */
  customerEmail?: string | null;
  content: string;
  source: MemorySource;
  sourceThreadId?: string | null;
  /** Present only for a structured slot write (see lib/agent/memory/slots.ts). Omit for a freeform note. */
  slotKey?: string | null;
  /**
   * Only meaningful together — a suggested pin from the self-observation
   * system (Phase 5.1) should still land as alwaysSurface: false until
   * the owner approves it; the caller is responsible for only passing
   * alwaysSurface: true once that approval has actually happened (or for
   * a direct owner pin_request, immediately).
   */
  alwaysSurface?: boolean;
  pinSource?: PinSource | null;
  importance?: number;
}

export interface AgentMemoryRow {
  id: string;
  tenant_id: string;
  scope: MemoryScope;
  customer_email: string | null;
  content: string;
  source: MemorySource;
  is_slot: boolean;
  slot_key: string | null;
  is_consequential: boolean;
  verified: boolean;
  always_surface: boolean;
  pin_source: PinSource | null;
  importance: number;
  superseded_by: string | null;
}

/**
 * Freeform notes within this cosine-similarity distance of an existing
 * note (same tenant + scope + customer_email) are treated as duplicates
 * of it rather than written again — per the original plan's "freeform
 * notes ... similarity-dedup against existing notes, threshold ~0.85+".
 * On a dedup hit, the existing row's use_count/last_used_at is bumped
 * instead of inserting a near-identical row.
 */
const NOTE_DEDUP_SIMILARITY_THRESHOLD = 0.85;

/** How many of the most recent existing notes (same scope) to compare a new note against. Keeps the dedup check cheap — this is an in-process comparison, not a database-side search. */
const DEDUP_CANDIDATE_LIMIT = 20;

export async function writeMemory(
  input: WriteMemoryInput
): Promise<AgentMemoryRow | null> {
  const supabase = createServiceSupabase();

  const customerEmail =
    input.scope === "customer" ? input.customerEmail ?? null : null;

  if (input.scope === "customer" && !customerEmail) {
    console.error(
      "MEMORY WRITE: customer-scope write with no customerEmail — refusing to write",
      { tenantId: input.tenantId, content: input.content.slice(0, 120) }
    );
    return null;
  }

  const embedding = await generateEmbedding(input.content);

  const slotKey = input.slotKey ?? null;
  const isSlot = slotKey !== null;
  const isConsequential = isSlot ? isConsequentialSlot(slotKey) : false;

  if (isSlot && !isKnownSlotKey(slotKey)) {
    console.error(
      "MEMORY WRITE: unknown slot key, writing as a freeform note instead:",
      { slotKey, tenantId: input.tenantId }
    );
  }

  const verified = isSlot ? !isConsequential : true;

  try {
    if (isSlot) {
      return await writeSlot({
        supabase,
        input,
        customerEmail,
        embedding,
        isConsequential,
        verified,
      });
    }

    return await writeNote({
      supabase,
      input,
      customerEmail,
      embedding,
    });
  } catch (error) {
    // Fails open: a memory write failing must never take down the
    // extraction/owner-instruction pipeline that called it.
    console.error("MEMORY WRITE failed:", error, {
      tenantId: input.tenantId,
      scope: input.scope,
      slotKey,
    });
    return null;
  }
}

async function writeSlot(params: {
  supabase: ReturnType<typeof createServiceSupabase>;
  input: WriteMemoryInput;
  customerEmail: string | null;
  embedding: number[] | null;
  isConsequential: boolean;
  verified: boolean;
}): Promise<AgentMemoryRow | null> {
  const { supabase, input, customerEmail, embedding, isConsequential, verified } = params;

  // Find the currently-active row for this exact slot, if any, so it can
  // be superseded rather than leaving two "active" values for the same
  // slot around at once.
  let existingQuery = supabase
    .from("agent_memories")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("scope", input.scope)
    .eq("slot_key", input.slotKey)
    .is("superseded_by", null);

  existingQuery =
    input.scope === "customer"
      ? existingQuery.eq("customer_email", customerEmail)
      : existingQuery.is("customer_email", null);

  const { data: existing, error: existingError } = await existingQuery.maybeSingle();

  if (existingError) {
    console.error("MEMORY WRITE (slot): lookup failed:", existingError);
  }

  const { data: inserted, error: insertError } = await supabase
    .from("agent_memories")
    .insert({
      tenant_id: input.tenantId,
      scope: input.scope,
      customer_email: customerEmail,
      content: input.content,
      embedding,
      source: input.source,
      source_thread_id: input.sourceThreadId ?? null,
      is_slot: true,
      slot_key: input.slotKey,
      is_consequential: isConsequential,
      verified,
      always_surface: input.alwaysSurface ?? false,
      pin_source: input.pinSource ?? null,
      importance: input.importance ?? (isConsequential ? 3 : 2),
      last_used_at: new Date().toISOString(),
      use_count: 0,
    })
    .select()
    .single();

  if (insertError || !inserted) {
    console.error("MEMORY WRITE (slot): insert failed:", insertError);
    return null;
  }

  if (existing?.id) {
    const { error: supersedeError } = await supabase
      .from("agent_memories")
      .update({ superseded_by: inserted.id })
      .eq("id", existing.id);

    if (supersedeError) {
      console.error(
        "MEMORY WRITE (slot): failed to mark previous value superseded — both rows now read as active, needs manual cleanup:",
        supersedeError,
        { previousId: existing.id, newId: inserted.id }
      );
    }
  }

  return inserted as AgentMemoryRow;
}

async function writeNote(params: {
  supabase: ReturnType<typeof createServiceSupabase>;
  input: WriteMemoryInput;
  customerEmail: string | null;
  embedding: number[] | null;
}): Promise<AgentMemoryRow | null> {
  const { supabase, input, customerEmail, embedding } = params;

  if (embedding) {
    let candidateQuery = supabase
      .from("agent_memories")
      .select("id, content, embedding, use_count")
      .eq("tenant_id", input.tenantId)
      .eq("scope", input.scope)
      .eq("is_slot", false)
      .is("superseded_by", null)
      .order("last_used_at", { ascending: false })
      .limit(DEDUP_CANDIDATE_LIMIT);

    candidateQuery =
      input.scope === "customer"
        ? candidateQuery.eq("customer_email", customerEmail)
        : candidateQuery.is("customer_email", null);

    const { data: candidates, error: candidatesError } = await candidateQuery;

    if (candidatesError) {
      console.error("MEMORY WRITE (note): dedup lookup failed:", candidatesError);
    }

    for (const candidate of candidates ?? []) {
      const candidateEmbedding = candidate.embedding as unknown as number[] | null;
      if (!candidateEmbedding) continue;

      const similarity = cosineSimilarity(embedding, candidateEmbedding);

      if (similarity >= NOTE_DEDUP_SIMILARITY_THRESHOLD) {
        const { data: bumped, error: bumpError } = await supabase
          .from("agent_memories")
          .update({
            last_used_at: new Date().toISOString(),
            use_count: (candidate.use_count ?? 0) + 1,
          })
          .eq("id", candidate.id)
          .select()
          .single();

        if (bumpError) {
          console.error("MEMORY WRITE (note): dedup bump failed:", bumpError);
        }

        return (bumped as AgentMemoryRow) ?? null;
      }
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("agent_memories")
    .insert({
      tenant_id: input.tenantId,
      scope: input.scope,
      customer_email: customerEmail,
      content: input.content,
      embedding,
      source: input.source,
      source_thread_id: input.sourceThreadId ?? null,
      is_slot: false,
      slot_key: null,
      is_consequential: false,
      verified: true,
      always_surface: input.alwaysSurface ?? false,
      pin_source: input.pinSource ?? null,
      importance: input.importance ?? 1,
      last_used_at: new Date().toISOString(),
      use_count: 0,
    })
    .select()
    .single();

  if (insertError || !inserted) {
    console.error("MEMORY WRITE (note): insert failed:", insertError);
    return null;
  }

  return inserted as AgentMemoryRow;
}
