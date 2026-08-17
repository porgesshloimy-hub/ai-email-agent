import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { encryptToken } from "@/lib/crypto";
import { watchGmail } from "@/lib/gmail/client";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");

  const storedState = request.headers
    .get("cookie")
    ?.match(
      /(?:^|;\s*)google_oauth_state=([^;]*)/
    )?.[1];

  if (!code) {
    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=missing_google_code",
        requestUrl.origin
      )
    );
  }

  if (!state || !storedState || state !== storedState) {
    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=invalid_google_state",
        requestUrl.origin
      )
    );
  }

  /**
   * IMPORTANT:
   * Use the same redirect URI as the OAuth client configuration.
   *
   * This must exactly match the redirect URI configured in Google
   * Cloud and the one used when creating the authorization URL.
   */
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${requestUrl.origin}/api/auth/google/callback`;

  if (!process.env.GOOGLE_CLIENT_ID) {
    console.error(
      "GOOGLE_CLIENT_ID is not configured"
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=google_config_missing",
        requestUrl.origin
      )
    );
  }

  if (!process.env.GOOGLE_CLIENT_SECRET) {
    console.error(
      "GOOGLE_CLIENT_SECRET is not configured"
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=google_config_missing",
        requestUrl.origin
      )
    );
  }

  /**
   * ------------------------------------------------------------
   * EXCHANGE AUTHORIZATION CODE FOR TOKENS
   * ------------------------------------------------------------
   */

  let tokenResponse: Response;
  let tokenData: any;

  try {
    tokenResponse = await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          client_id:
            process.env.GOOGLE_CLIENT_ID,
          client_secret:
            process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      }
    );

    tokenData = await tokenResponse.json();
  } catch (error) {
    console.error(
      "Google token exchange request failed:",
      error
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=google_token_exchange_failed",
        requestUrl.origin
      )
    );
  }

  if (!tokenResponse.ok) {
    console.error(
      "Google token exchange failed:",
      {
        status: tokenResponse.status,
        error: tokenData?.error,
        errorDescription:
          tokenData?.error_description,
      }
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=google_token_exchange_failed",
        requestUrl.origin
      )
    );
  }

  const {
    access_token,
    refresh_token,
    expires_in,
  } = tokenData;

  if (!access_token) {
    console.error(
      "Google did not return an access token:",
      tokenData
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=missing_google_access_token",
        requestUrl.origin
      )
    );
  }

  /**
   * ------------------------------------------------------------
   * GET GOOGLE ACCOUNT INFORMATION
   * ------------------------------------------------------------
   */

  const userInfoResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: {
        Authorization:
          `Bearer ${access_token}`,
      },
    }
  );

  const userInfo =
    await userInfoResponse.json();

  if (
    !userInfoResponse.ok ||
    !userInfo.email
  ) {
    console.error(
      "Google userinfo failed:",
      {
        status:
          userInfoResponse.status,
        data: userInfo,
      }
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=google_userinfo_failed",
        requestUrl.origin
      )
    );
  }

  /**
   * ------------------------------------------------------------
   * VERIFY PRIME AUTOMATIC USER
   * ------------------------------------------------------------
   */

  const supabase =
    await createServerSupabase();

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

  /**
   * ------------------------------------------------------------
   * FIND TENANT
   * ------------------------------------------------------------
   */

  const {
    data: tenant,
    error: tenantError,
  } = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user.id)
    .single();

  if (tenantError || !tenant) {
    console.error(
      "Tenant lookup failed:",
      tenantError
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=tenant_not_found",
        requestUrl.origin
      )
    );
  }

  /**
   * ------------------------------------------------------------
   * PREPARE TOKENS
   * ------------------------------------------------------------
   */

  const encryptedAccessToken =
    encryptToken(access_token);

  let encryptedRefreshToken:
    | string
    | null = null;

  if (refresh_token) {
    encryptedRefreshToken =
      encryptToken(refresh_token);
  }

  const tokenExpiry =
    new Date(
      Date.now() +
        (expires_in ?? 3600) * 1000
    ).toISOString();

  /**
   * ------------------------------------------------------------
   * CHECK EXISTING CONNECTION
   * ------------------------------------------------------------
   *
   * If Google does not return a refresh token during a
   * reauthorization, preserve the existing one.
   *
   * However, if the previous refresh token was revoked,
   * Google should normally issue a new refresh token when
   * the OAuth flow is performed with the appropriate consent
   * settings.
   */

  const {
    data: existingConnection,
    error: existingConnectionError,
  } = await supabase
    .from("gmail_connections")
    .select(
      "id, refresh_token_encrypted"
    )
    .eq("tenant_id", tenant.id)
    .maybeSingle();

  if (existingConnectionError) {
    console.error(
      "Existing Google connection lookup failed:",
      existingConnectionError
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=google_connection_lookup_failed",
        requestUrl.origin
      )
    );
  }

  /**
   * ------------------------------------------------------------
   * SAVE CONNECTION
   * ------------------------------------------------------------
   */

  const connectionData:
    Record<string, unknown> = {
    tenant_id: tenant.id,
    gmail_address: userInfo.email,
    access_token_encrypted:
      encryptedAccessToken,
    token_expiry: tokenExpiry,

    /**
     * A successful OAuth connection means the previous
     * reauthentication requirement has been resolved.
     */
    google_reauth_required: false,

    /**
     * Calendar permission was requested by this OAuth flow.
     */
    calendar_scope_granted: true,

    connected_at:
      new Date().toISOString(),
  };

  /**
   * Google does not always return a refresh token.
   *
   * Preserve the existing refresh token if Google omitted
   * one during this authorization.
   */
  if (encryptedRefreshToken) {
    connectionData.refresh_token_encrypted =
      encryptedRefreshToken;
  } else if (
    existingConnection?.refresh_token_encrypted
  ) {
    connectionData.refresh_token_encrypted =
      existingConnection.refresh_token_encrypted;
  } else {
    /**
     * We cannot safely operate long-term without a refresh token.
     */
    console.error(
      "Google OAuth returned no refresh token and no existing refresh token exists."
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=missing_google_refresh_token",
        requestUrl.origin
      )
    );
  }

  let saveError;

  if (existingConnection) {
    const result =
      await supabase
        .from("gmail_connections")
        .update(connectionData)
        .eq(
          "id",
          existingConnection.id
        );

    saveError = result.error;
  } else {
    const result =
      await supabase
        .from("gmail_connections")
        .insert(connectionData);

    saveError = result.error;
  }

  if (saveError) {
    console.error(
      "Failed to save Google connection:",
      saveError
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=google_connection_save_failed",
        requestUrl.origin
      )
    );
  }

  console.log(
    "GOOGLE CONNECTION SAVED:",
    {
      tenantId: tenant.id,
      gmailAddress: userInfo.email,
      refreshTokenReturned:
        Boolean(refresh_token),
      reauthCleared: true,
    }
  );

  /**
   * ------------------------------------------------------------
   * REGISTER GMAIL PUSH NOTIFICATIONS
   * ------------------------------------------------------------
   *
   * This is also a useful validation step because watchGmail()
   * actually uses the newly saved OAuth credentials.
   */

  try {
    const watch =
      await watchGmail(
        tenant.id
      );

    if (
      watch.historyId &&
      watch.expiration
    ) {
      const {
        error: watchSaveError,
      } = await supabase
        .from("gmail_connections")
        .update({
          history_id:
            watch.historyId,
          watch_expiry:
            new Date(
              Number(
                watch.expiration
              )
            ).toISOString(),
        })
        .eq(
          "tenant_id",
          tenant.id
        );

      if (watchSaveError) {
        console.error(
          "Gmail watch was created but could not be saved:",
          watchSaveError
        );

        return NextResponse.redirect(
          new URL(
            "/dashboard/settings?error=gmail_watch_save_failed",
            requestUrl.origin
          )
        );
      }
    } else {
      console.error(
        "Gmail watch did not return historyId or expiration:",
        watch
      );

      return NextResponse.redirect(
        new URL(
          "/dashboard/settings?error=gmail_watch_failed",
          requestUrl.origin
        )
      );
    }
  } catch (error: any) {
    console.error(
      "Failed to register Gmail watch:",
      {
        tenantId: tenant.id,
        errorCode: error?.code,
        errorMessage: error?.message,
        responseData:
          error?.response?.data,
      }
    );

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=gmail_watch_failed",
        requestUrl.origin
      )
    );
  }

  /**
   * ------------------------------------------------------------
   * SUCCESS
   * ------------------------------------------------------------
   */

  const response =
    NextResponse.redirect(
      new URL(
        "/dashboard/settings?google_connected=true",
        requestUrl.origin
      )
    );

  /**
   * OAuth state is single-use.
   */
  response.cookies.set(
    "google_oauth_state",
    "",
    {
      httpOnly: true,
      secure:
        process.env.NODE_ENV ===
        "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    }
  );

  return response;
}