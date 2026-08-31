import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";

/**
 * Same pattern as the other agent-chat routes — duplicated per this
 * codebase's existing convention rather than extracted into a shared
 * helper.
 */
async function getAuthenticatedTenantId(): Promise<string> {
  const userSupabase = await createServerSupabase();

  const {
    data: { user },
    error: userError,
  } = await userSupabase.auth.getUser();

  if (userError || !user) {
    throw new Error("Not authenticated");
  }

  const { data: tenant, error: tenantError } = await userSupabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user.id)
    .single();

  if (tenantError || !tenant) {
    throw new Error("Tenant not found");
  }

  return tenant.id;
}

/**
 * Records that the owner is actively typing right now. The client
 * calls this (throttled — see AgentChatPanel.tsx) while there's text
 * in the composer, and lib/inngest/functions.ts's
 * processDelayedChatReply checks freshness of this timestamp to decide
 * whether to keep waiting rather than responding — a genuinely
 * different signal from "did another message arrive," since it lets
 * the agent hold off even before a follow-up is actually sent.
 *
 * Deliberately a plain timestamp column on `tenants`, not a new table
 * — this is single-row, constantly-overwritten, ephemeral state with
 * no history value once stale.
 */
export async function POST() {
  try {
    const tenantId = await getAuthenticatedTenantId();
    const supabase = createServiceSupabase();

    const { error } = await supabase
      .from("tenants")
      .update({ owner_last_typing_at: new Date().toISOString() })
      .eq("id", tenantId);

    if (error) {
      console.error("FAILED TO RECORD TYPING SIGNAL:", { tenantId, error });
      return NextResponse.json({ error: "Failed to record typing" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 401 }
    );
  }
}
