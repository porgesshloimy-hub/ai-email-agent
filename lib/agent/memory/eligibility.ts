import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * shouldExtractMemory(tenantId, customerEmail) — true once there's a 2nd
 * inbound message from this sender OR a completed tool call tagged
 * marksCapabilityCompleted happened during the current run.
 *
 * IMPLEMENTATION NOTE on the 2nd condition: the original plan phrased
 * this as "a completed tool call tagged marksCapabilityCompleted exists
 * for this thread," suggesting a database lookup. email_actions and
 * calendar_actions currently carry no customer/sender column linking a
 * completed action back to a specific thread's customer (calendar_actions
 * in particular has no thread_id or customer_email at all — see
 * db/schema.sql), so querying for this after the fact would require a
 * schema change to those tables, which is out of scope for this pass.
 * Instead, lib/agent/run.ts already builds a per-run "completed
 * capabilities" ledger from ToolDefinition.marksCapabilityCompleted (see
 * lib/agent/tools/types.ts and lib/agent/grounding-guard.ts, which reads
 * that same ledger) — this function accepts that ledger's result
 * directly via `completedCapabilityThisRun` rather than re-deriving it
 * from a database round trip that doesn't have the data to answer the
 * question anyway. Functionally identical for the case that matters (a
 * first contact that immediately results in a real booking should still
 * be eligible for extraction), without inventing new schema whose
 * ownership belongs to a different part of the system.
 */
export async function shouldExtractMemory(
  tenantId: string,
  customerEmail: string,
  options?: { completedCapabilityThisRun?: boolean }
): Promise<boolean> {
  if (options?.completedCapabilityThisRun) {
    return true;
  }

  const supabase = createServiceSupabase();

  const { count, error } = await supabase
    .from("email_actions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("customer_email", customerEmail);

  if (error) {
    console.error("MEMORY ELIGIBILITY: lookup failed, defaulting to not-eligible:", error, {
      tenantId,
      customerEmail,
    });
    return false;
  }

  return (count ?? 0) >= 2;
}
