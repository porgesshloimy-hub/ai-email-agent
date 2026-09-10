import OpenAI from "openai";

/**
 * Shared, provider-independent helpers for the memory system. Deliberately
 * separate from lib/agent/llm/ (the multi-provider chat adapters) — every
 * embedding call in this codebase (lib/agent/run.ts's searchKnowledge, and
 * everything in this module) goes directly through OpenAI regardless of a
 * tenant's chosen chat provider, because the stored vectors are fixed-size
 * and tied to one specific embedding model. See run.ts's comment above its
 * own `openai` instance for the full rationale; this is the same model
 * ("text-embedding-3-small") for the same reason, kept in its own client
 * here so lib/agent/memory/* doesn't need to import run.ts.
 */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Embeds a piece of text for storage or similarity search against
 * agent_memories.embedding / knowledge_chunks.embedding. Returns null on
 * any failure (missing key, empty input, API error) — every call site in
 * this module fails open rather than throwing, consistent with the plan's
 * "memory extraction/search never blocks the send path" principle.
 */
export async function generateEmbedding(
  text: string
): Promise<number[] | null> {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: trimmed,
    });

    return response.data[0]?.embedding ?? null;
  } catch (error) {
    console.error("MEMORY: embedding generation failed:", error);
    return null;
  }
}

/**
 * Cosine similarity between two equal-length embedding vectors. Used for
 * in-process near-duplicate detection (write.ts's freeform-note dedup)
 * where comparing against a small number of already-fetched candidates in
 * code is simpler than round-tripping through a database function.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Pulls the bare address out of a "Display Name <addr@example.com>"
 * From-header-style string (what lib/gmail/client.ts hands back as
 * IncomingEmail.from in lib/agent/run.ts), lowercased for consistent
 * matching against agent_memories.customer_email. Falls back to
 * lowercasing the trimmed input as-is if no angle-bracket address is
 * found (e.g. the input was already a bare address, or came from a
 * surface — like chat — where the owner just typed an address directly).
 */
export function extractEmailAddress(raw: string): string {
  const match = raw.match(/<([^<>]+)>/);
  const candidate = (match ? match[1] : raw).trim().toLowerCase();
  return candidate;
}
