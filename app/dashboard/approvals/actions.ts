"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";

/**
 * This is the ONLY place in the whole app where a gated "send" actually
 * happens. It requires an authenticated dashboard request from the tenant's
 * own owner — never triggered by the agent pipeline directly.
 */
export async function approveAndSend(formData: FormData) {
  const actionId = formData.get("actionId") as string;

  const userSupabase = await createServerSupabase();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const supabase = createServiceSupabase();

  const { data: action } = await supabase
    .from("email_actions")
    .select("*, tenants!inner(owner_user_id)")
    .eq("id", actionId)
    .single();

  // Ownership check — never trust the client-submitted actionId alone.
  if (!action || (action as any).tenants.owner_user_id !== user.id) {
    throw new Error("Not authorized to approve this draft");
  }

  if (!action.gmail_draft_id) throw new Error("No Gmail draft id stored for this action");

  const { sendDraft } = await import("@/lib/gmail/client");
  await sendDraft(action.tenant_id, action.gmail_draft_id);

  await supabase
    .from("email_actions")
    .update({ status: "sent", resolved_at: new Date().toISOString() })
    .eq("id", actionId);

  revalidatePath("/dashboard/approvals");
}

export async function rejectDraft(formData: FormData) {
  const actionId = formData.get("actionId") as string;

  const userSupabase = await createServerSupabase();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const supabase = createServiceSupabase();
  const { data: action } = await supabase
    .from("email_actions")
    .select("*, tenants!inner(owner_user_id)")
    .eq("id", actionId)
    .single();

  if (!action || (action as any).tenants.owner_user_id !== user.id) {
    throw new Error("Not authorized to reject this draft");
  }

  await supabase
    .from("email_actions")
    .update({ status: "rejected", resolved_at: new Date().toISOString() })
    .eq("id", actionId);

  revalidatePath("/dashboard/approvals");
}