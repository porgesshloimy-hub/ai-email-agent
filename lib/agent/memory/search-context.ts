import { createServiceSupabase } from "@/lib/supabase/server";
import { generateEmbedding } from "./util";

/**
 * Tier 2 of the memory retrieval model: the agent-invoked search behind
 * the search_context tool (lib/agent/tools/search-context.ts). Federated,
 * not merged — this queries agent_memories (via the match_agent_memories
 * RPC added in migration 018) and knowledge_chunks (via the existing
 * match_knowledge_chunks RPC that lib/agent/run.ts's searchKnowledge
 * already uses) as two separate stores, and returns one list tagged by
 * source. Business knowledge is owner-curated and always-true; customer
 * memory carries a trust gradient (source/verified) that must stay
 * visible to the agent — merging the two tables or write paths would
 * lose that distinction, which is why this stays a federated call
 * rather than a single unified query. See the build plan's section 0.1.
 *
 * One embedding call covers both RPCs (same query text, same embedding
 * model as knowledge_chunks/agent_memories both use — text-embedding-3-small).
 */

export type SearchContextScope = "memory" | "knowledge" | "both";

export interface SearchContextResult {
  source: "customer_memory" | "business_knowledge";
  content: string;
  similarity: number;
  // Present only for source: "customer_memory" — the trust gradient
  // that must never get lost by treating this the same as a knowledge
  // chunk.
  memoryId?: string;
  memoryScope?: "tenant" | "customer";
  provenance?: "extracted" | "owner_stated" | "customer_stated";
  verified?: boolean;
}

export interface SearchContextInput {
  tenantId: string;
  customerEmail?: string | null;
  query: string;
  scope?: SearchContextScope;
}

/**
 * Same convention as run.ts's KNOWLEDGE_SIMILARITY_THRESHOLD — both RPCs
 * return cosine similarity (1 - distance, higher is better); results
 * below this are dropped rather than handed to the model as if they
 * were a real match. Kept as its own constant (not imported from run.ts)
 * since memory content tends to be short, conversational sentences
 * rather than document prose, and may warrant separate tuning later.
 */
const MEMORY_SIMILARITY_THRESHOLD = 0.6;
const KNOWLEDGE_SIMILARITY_THRESHOLD = 0.65;

const MEMORY_MATCH_COUNT = 8;
const KNOWLEDGE_MATCH_COUNT = 5;

export async function searchContext(
  input: SearchContextInput
): Promise<SearchContextResult[]> {
  const query = input.query.trim();

  if (!query) {
    return [];
  }

  const scope = input.scope ?? "both";

  const embedding = await generateEmbedding(query);

  if (!embedding) {
    console.error("SEARCH_CONTEXT: no embedding, returning empty result", {
      tenantId: input.tenantId,
    });
    return [];
  }

  const supabase = createServiceSupabase();

  const [memoryResults, knowledgeResults] = await Promise.all([
    scope === "memory" || scope === "both"
      ? searchMemory(supabase, input.tenantId, input.customerEmail ?? null, embedding)
      : Promise.resolve([]),
    scope === "knowledge" || scope === "both"
      ? searchKnowledgeChunks(supabase, input.tenantId, embedding)
      : Promise.resolve([]),
  ]);

  return [...memoryResults, ...knowledgeResults];
}

async function searchMemory(
  supabase: ReturnType<typeof createServiceSupabase>,
  tenantId: string,
  customerEmail: string | null,
  embedding: number[]
): Promise<SearchContextResult[]> {
  const { data, error } = await supabase.rpc("match_agent_memories", {
    query_embedding: embedding,
    match_tenant_id: tenantId,
    match_customer_email: customerEmail,
    match_count: MEMORY_MATCH_COUNT,
  });

  if (error) {
    console.error("SEARCH_CONTEXT: match_agent_memories failed:", error);
    return [];
  }

  const rows = (data ?? []) as {
    id: string;
    content: string;
    scope: "tenant" | "customer";
    source: "extracted" | "owner_stated" | "customer_stated";
    verified: boolean;
    similarity: number;
  }[];

  const accepted = rows.filter((row) => row.similarity >= MEMORY_SIMILARITY_THRESHOLD);

  if (accepted.length > 0) {
    // Fire-and-forget usage bump — a failure here must never affect the
    // search result itself.
    bumpMemoryUsage(supabase, accepted.map((row) => row.id)).catch((error) => {
      console.error("SEARCH_CONTEXT: usage bump failed:", error);
    });
  }

  return accepted.map((row) => ({
    source: "customer_memory" as const,
    content: row.content,
    similarity: row.similarity,
    memoryId: row.id,
    memoryScope: row.scope,
    provenance: row.source,
    verified: row.verified,
  }));
}

async function searchKnowledgeChunks(
  supabase: ReturnType<typeof createServiceSupabase>,
  tenantId: string,
  embedding: number[]
): Promise<SearchContextResult[]> {
  const { data, error } = await supabase.rpc("match_knowledge_chunks", {
    query_embedding: embedding,
    match_tenant_id: tenantId,
    match_count: KNOWLEDGE_MATCH_COUNT,
  });

  if (error) {
    console.error("SEARCH_CONTEXT: match_knowledge_chunks failed:", error);
    return [];
  }

  const rows = (data ?? []) as { content?: string | null; similarity?: number | null }[];

  return rows
    .filter(
      (row): row is { content: string; similarity: number } =>
        typeof row.content === "string" &&
        row.content.trim().length > 0 &&
        typeof row.similarity === "number" &&
        row.similarity >= KNOWLEDGE_SIMILARITY_THRESHOLD
    )
    .map((row) => ({
      source: "business_knowledge" as const,
      content: row.content,
      similarity: row.similarity,
    }));
}

async function bumpMemoryUsage(
  supabase: ReturnType<typeof createServiceSupabase>,
  memoryIds: string[]
): Promise<void> {
  if (memoryIds.length === 0) return;

  // Supabase JS has no atomic "increment" helper for a plain update, and
  // this is a best-effort usage signal (feeds weekly decay/consolidation,
  // Phase 6.1) rather than a value anything correctness-critical depends
  // on — a read-then-write race here just under-counts use_count by one
  // occasionally, which is an acceptable trade for not needing a
  // dedicated RPC just for this increment.
  const { data: rows, error: readError } = await supabase
    .from("agent_memories")
    .select("id, use_count")
    .in("id", memoryIds);

  if (readError || !rows) {
    console.error("SEARCH_CONTEXT: usage bump read failed:", readError);
    return;
  }

  const now = new Date().toISOString();

  await Promise.all(
    rows.map((row) =>
      supabase
        .from("agent_memories")
        .update({ last_used_at: now, use_count: (row.use_count ?? 0) + 1 })
        .eq("id", row.id)
    )
  );
}
