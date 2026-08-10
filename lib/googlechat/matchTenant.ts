import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * A business owner chats with the bot using their own Google account. That
 * account is usually the same one connected as the agent's Gmail (small
 * businesses tend to run everything from one inbox), so this checks
 * gmail_connections first. Falls back to tenants.owner_google_email for
 * cases where the owner wants to chat from a different Google account than
 * the one the agent monitors — set from the Settings page.
 */
export async function findTenantByGoogleChatSender(senderEmail: string): Promise<string | null> {
  const supabase = createServiceSupabase();

  const { data: byGmail } = await supabase
    .from("gmail_connections")
    .select("tenant_id")
    .eq("gmail_address", senderEmail)
    .maybeSingle();

  if (byGmail?.tenant_id) return byGmail.tenant_id;

  const { data: byOwnerEmail } = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_google_email", senderEmail)
    .maybeSingle();

  return byOwnerEmail?.id ?? null;
}
