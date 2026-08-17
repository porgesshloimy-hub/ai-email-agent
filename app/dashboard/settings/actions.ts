"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";

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