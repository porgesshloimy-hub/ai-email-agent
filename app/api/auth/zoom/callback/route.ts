import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { encryptToken } from "@/lib/crypto";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

  const code = requestUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=missing_zoom_code",
        requestUrl.origin
      )
    );
  }

  const redirectUri =
    `${requestUrl.origin}/api/auth/zoom/callback`;

  // Exchange Zoom's authorization code for tokens.
  const tokenResponse = await fetch(
    "https://zoom.us/oauth/token",
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
          ).toString("base64"),
          "Content-Type":
            "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    }
  );

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    console.error("Zoom token exchange failed:", tokenData);

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=zoom_token_exchange_failed",
        requestUrl.origin
      )
    );
  }

  const {
    access_token,
    refresh_token,
    expires_in,
  } = tokenData;

  if (!access_token || !refresh_token) {
    console.error(
      "Zoom did not return the required OAuth tokens:",
      tokenData
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=missing_zoom_tokens",
        requestUrl.origin
      )
    );
  }

  // Get information about the Zoom account that authorized the app.
  const userInfoResponse = await fetch(
    "https://api.zoom.us/v2/users/me",
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    }
  );

  const userInfo = await userInfoResponse.json();

  if (!userInfoResponse.ok || !userInfo.id) {
    console.error("Zoom user info failed:", userInfo);

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=zoom_userinfo_failed",
        requestUrl.origin
      )
    );
  }

  // Make sure the person connecting Zoom is logged into Prime Automatic.
  const supabase = await createServerSupabase();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(
      new URL(
        "/?error=not_authenticated",
        requestUrl.origin
      )
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
      new URL(
        "/dashboard/settings?error=tenant_not_found",
        requestUrl.origin
      )
    );
  }

  const encryptedAccessToken =
    encryptToken(access_token);

  const encryptedRefreshToken =
    encryptToken(refresh_token);

  const tokenExpiry = new Date(
    Date.now() + (expires_in ?? 3600) * 1000
  ).toISOString();

  const connectionData = {
    tenant_id: tenant.id,
    zoom_user_id: userInfo.id,
    zoom_email: userInfo.email ?? null,
    access_token_encrypted: encryptedAccessToken,
    refresh_token_encrypted: encryptedRefreshToken,
    token_expiry: tokenExpiry,
    connected_at: new Date().toISOString(),
  };

  // Check whether this tenant already has a Zoom connection.
  const { data: existingConnection } = await supabase
    .from("zoom_connections")
    .select("id")
    .eq("tenant_id", tenant.id)
    .maybeSingle();

  let saveError;

  if (existingConnection) {
    const result = await supabase
      .from("zoom_connections")
      .update(connectionData)
      .eq("id", existingConnection.id);

    saveError = result.error;
  } else {
    const result = await supabase
      .from("zoom_connections")
      .insert(connectionData);

    saveError = result.error;
  }

  if (saveError) {
    console.error(
      "Failed to save Zoom connection:",
      saveError
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=zoom_connection_save_failed",
        requestUrl.origin
      )
    );
  }

  return NextResponse.redirect(
    new URL(
      "/dashboard/settings?zoom_connected=true",
      requestUrl.origin
    )
  );
}