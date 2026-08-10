import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { encryptToken } from "@/lib/crypto";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");

  const storedState = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)google_oauth_state=([^;]*)/)?.[1];

  if (!code) {
    return NextResponse.redirect(
      new URL("/dashboard/settings?error=missing_google_code", requestUrl.origin)
    );
  }

  if (!state || !storedState || state !== storedState) {
    return NextResponse.redirect(
      new URL("/dashboard/settings?error=invalid_google_state", requestUrl.origin)
    );
  }

  const redirectUri =
    `${requestUrl.origin}/api/auth/google/callback`;

  // Exchange Google's authorization code for tokens.
  const tokenResponse = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    }
  );

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    console.error("Google token exchange failed:", tokenData);

    return NextResponse.redirect(
      new URL("/dashboard/settings?error=google_token_exchange_failed", requestUrl.origin)
    );
  }

  const {
    access_token,
    refresh_token,
    expires_in,
  } = tokenData;

  if (!access_token) {
    console.error("Google did not return an access token:", tokenData);

    return NextResponse.redirect(
      new URL("/dashboard/settings?error=missing_google_access_token", requestUrl.origin)
    );
  }

  // Get the Google account's email address.
  const userInfoResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    }
  );

  const userInfo = await userInfoResponse.json();

  if (!userInfoResponse.ok || !userInfo.email) {
    console.error("Google userinfo failed:", userInfo);

    return NextResponse.redirect(
      new URL("/dashboard/settings?error=google_userinfo_failed", requestUrl.origin)
    );
  }

  // Make sure the person connecting Google is logged into Prime Automatic.
  const supabase = await createServerSupabase();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(
      new URL("/?error=not_authenticated", requestUrl.origin)
    );
  }

  // Find the tenant belonging to this logged-in user.
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user.id)
    .single();

  if (tenantError || !tenant) {
    console.error("Tenant lookup failed:", tenantError);

    return NextResponse.redirect(
      new URL("/dashboard/settings?error=tenant_not_found", requestUrl.origin)
    );
  }

  // Google may not return a refresh token if the account was already
  // authorized previously. In that case, don't overwrite an existing
  // refresh token with null.
  const encryptedAccessToken = encryptToken(access_token);

  let encryptedRefreshToken: string | null = null;

  if (refresh_token) {
    encryptedRefreshToken = encryptToken(refresh_token);
  }

  const tokenExpiry = new Date(
    Date.now() + (expires_in ?? 3600) * 1000
  ).toISOString();

  // Check whether this tenant already has a connection.
  const { data: existingConnection } = await supabase
    .from("gmail_connections")
    .select("id, refresh_token_encrypted")
    .eq("tenant_id", tenant.id)
    .maybeSingle();

  const connectionData: Record<string, unknown> = {
    tenant_id: tenant.id,
    gmail_address: userInfo.email,
    access_token_encrypted: encryptedAccessToken,
    token_expiry: tokenExpiry,
    calendar_scope_granted: true,
    connected_at: new Date().toISOString(),
  };

  if (encryptedRefreshToken) {
    connectionData.refresh_token_encrypted = encryptedRefreshToken;
  } else if (existingConnection?.refresh_token_encrypted) {
    connectionData.refresh_token_encrypted =
      existingConnection.refresh_token_encrypted;
  }

  let saveError;

  if (existingConnection) {
    const result = await supabase
      .from("gmail_connections")
      .update(connectionData)
      .eq("id", existingConnection.id);

    saveError = result.error;
  } else {
    const result = await supabase
      .from("gmail_connections")
      .insert(connectionData);

    saveError = result.error;
  }

  if (saveError) {
    console.error("Failed to save Google connection:", saveError);

    return NextResponse.redirect(
      new URL("/dashboard/settings?error=google_connection_save_failed", requestUrl.origin)
    );
  }

  const response = NextResponse.redirect(
    new URL("/dashboard/settings?google_connected=true", requestUrl.origin)
  );

  // Delete the OAuth state cookie after successful use.
  response.cookies.set("google_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return response;
}