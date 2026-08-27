"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { isValidTimezone } from "@/lib/timezones";

async function getTenantId() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user?.id)
    .single();

  return { supabase, tenantId: tenant?.id };
}

/**
 * The business's own operating timezone — see lib/agent/date-context.ts
 * for what this actually controls (what the agent considers "today").
 * Validated against the runtime's own Intl implementation
 * (lib/timezones.ts's isValidTimezone) rather than trusting whatever a
 * <select> happened to submit — the option list is a UI convenience,
 * not the source of truth for what's a real IANA zone.
 */
export async function saveTimezone(formData: FormData) {
  const timezone = String(formData.get("timezone") ?? "").trim();

  if (!isValidTimezone(timezone)) {
    throw new Error(`"${timezone}" is not a recognized timezone.`);
  }

  const { supabase, tenantId } = await getTenantId();
  if (!tenantId) return;

  const { error } = await supabase
    .from("tenants")
    .update({ timezone })
    .eq("id", tenantId);

  if (error) {
    throw new Error(`Failed to save timezone: ${error.message}`);
  }

  revalidatePath("/dashboard/settings");
}

export async function disconnectGoogle() {
  const { supabase, tenantId } = await getTenantId();
  if (!tenantId) return;

  await supabase.from("gmail_connections").delete().eq("tenant_id", tenantId);
  revalidatePath("/settings");
}

export async function disconnectZoom() {
  const { supabase, tenantId } = await getTenantId();
  if (!tenantId) return;

  await supabase.from("zoom_connections").delete().eq("tenant_id", tenantId);
  revalidatePath("/settings");
}