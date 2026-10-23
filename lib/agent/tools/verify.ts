import type { SupabaseServiceClient } from "./types";

/**
 * Read-back verification for tools that write.
 *
 * A write call that returns no error is not proof the thing is there:
 * an update can match zero rows, a policy or trigger can quietly change
 * what was stored, and a tool that reports success because "nothing
 * threw" is exactly how an agent ends up confirming work that never
 * happened. After writing, tools call this to fetch the row again —
 * scoped to the tenant — and report success only if what is stored is
 * what they meant to store.
 *
 * Returns the row (or null when no row exists, which is the expected
 * result when verifying a delete) or, if the lookup itself failed, an
 * error so the caller can say "I couldn't verify" instead of guessing
 * either way.
 */
export async function readBackRow(
  supabase: SupabaseServiceClient,
  table: string,
  id: string,
  tenantId: string,
  columns: string
): Promise<{ ok: true; row: Record<string, any> | null } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (error) return { ok: false, error: error.message };
    return { ok: true, row: (data as Record<string, any> | null) ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** What a tool tells the model when the write happened but couldn't be confirmed by reading it back. */
export function unverifiedMessage(what: string, reason: string): string {
  return `${what} was written, but I could NOT verify it by reading it back (${reason}). Do not tell the owner it's done — tell them it may not have gone through and to double-check.`;
}
