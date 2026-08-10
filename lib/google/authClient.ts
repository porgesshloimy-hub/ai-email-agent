import { google } from "googleapis";
import { createServiceSupabase } from "@/lib/supabase/server";
import { decryptToken, encryptToken } from "@/lib/crypto";

/**
 * Gmail and Calendar share one OAuth grant — Google issues a single token
 * covering every scope requested at consent time, so both API wrappers
 * pull from the same gmail_connections row rather than maintaining
 * separate token storage.
 */
export async function getGoogleAuthedClient(tenantId: string) {
  const supabase = createServiceSupabase();
  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .single();

  if (!conn) throw new Error(`No Google connection for tenant ${tenantId}`);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: decryptToken(conn.access_token_encrypted),
    refresh_token: decryptToken(conn.refresh_token_encrypted),
    expiry_date: new Date(conn.token_expiry).getTime(),
  });

  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await supabase
        .from("gmail_connections")
        .update({
          access_token_encrypted: encryptToken(tokens.access_token),
          token_expiry: new Date(tokens.expiry_date!).toISOString(),
        })
        .eq("tenant_id", tenantId);
    }
  });

  return oauth2Client;
}

export async function tenantHasCalendarAccess(tenantId: string): Promise<boolean> {
  const supabase = createServiceSupabase();
  const { data } = await supabase
    .from("gmail_connections")
    .select("calendar_scope_granted")
    .eq("tenant_id", tenantId)
    .single();
  return data?.calendar_scope_granted ?? false;
}
