import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { createServiceSupabase } from "@/lib/supabase/server";
import { encryptToken } from "@/lib/crypto";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const userId = req.nextUrl.searchParams.get("state"); // set in the initiate step

  if (!code || !userId) {
    return NextResponse.redirect(new URL("/dashboard/settings?gmail_error=missing_params", req.url));
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token) {
    // Google only returns refresh_token on first consent — if missing here,
    // the user likely already connected before without revoking access.
    return NextResponse.redirect(new URL("/dashboard/settings?gmail_error=no_refresh_token", req.url));
  }

  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: "me" });

  // Service role: this write happens in a server-only route on behalf of a
  // known, authenticated user id, not a browser session — RLS is bypassed
  // intentionally here, scoped explicitly by tenant lookup below.
  const supabase = createServiceSupabase();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", userId)
    .single();

  if (!tenant) {
    return NextResponse.redirect(new URL("/dashboard/settings?gmail_error=no_tenant", req.url));
  }

  await supabase.from("gmail_connections").upsert({
    tenant_id: tenant.id,
    gmail_address: profile.data.emailAddress,
    access_token_encrypted: encryptToken(tokens.access_token),
    refresh_token_encrypted: encryptToken(tokens.refresh_token),
    token_expiry: new Date(tokens.expiry_date!).toISOString(),
  });

  // Register Gmail push notifications (Pub/Sub) so new mail triggers
  // processing without polling. Requires GOOGLE_PUBSUB_TOPIC to be configured
  // as a Pub/Sub topic that Gmail's service account has publish rights on.
  const watchResponse = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: process.env.GOOGLE_PUBSUB_TOPIC,
      labelIds: ["INBOX"],
    },
  });

  await supabase
    .from("gmail_connections")
    .update({
      history_id: watchResponse.data.historyId,
      watch_expiry: new Date(Number(watchResponse.data.expiration)).toISOString(),
    })
    .eq("tenant_id", tenant.id);

  return NextResponse.redirect(new URL("/dashboard/settings?gmail_connected=1", req.url));
}
