import { google } from "googleapis";
import { createServiceSupabase } from "@/lib/supabase/server";
import { decryptToken, encryptToken } from "@/lib/crypto";

/**
 * Gmail and Calendar share one OAuth grant — Google issues a single token
 * covering every scope requested at consent time, so both API wrappers
 * pull from the same gmail_connections row rather than maintaining
 * separate token storage.
 *
 * IMPORTANT:
 * A Google refresh token can become invalid if the user revokes access,
 * the OAuth grant expires/revokes, the account is changed, or Google
 * invalidates the grant for another reason.
 *
 * When that happens Google returns:
 *
 *   invalid_grant
 *   Token has been expired or revoked.
 *
 * We treat that as a REAUTH REQUIRED state rather than allowing the
 * exception to repeatedly crash Gmail sync jobs.
 */
export async function getGoogleAuthedClient(tenantId: string) {
  const supabase = createServiceSupabase();

  const { data: conn, error: connectionError } = await supabase
    .from("gmail_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .single();

  if (connectionError) {
    console.error("GOOGLE CONNECTION LOOKUP FAILED:", {
      tenantId,
      error: connectionError,
    });

    throw new Error(
      `Failed to load Google connection for tenant ${tenantId}`
    );
  }

  if (!conn) {
    throw new Error(
      `No Google connection for tenant ${tenantId}`
    );
  }

  /**
   * If the connection has already been marked as requiring
   * reauthentication, fail immediately.
   *
   * This prevents every Gmail sync invocation from attempting
   * to refresh the same known-invalid Google grant.
   *
   * This check is conditional because older database schemas may
   * not yet contain the reauth column.
   */
  if ((conn as any).google_reauth_required === true) {
    console.warn("GOOGLE REAUTH REQUIRED:", {
      tenantId,
    });

    throw new Error("GOOGLE_REAUTH_REQUIRED");
  }

  let accessToken: string;
  let refreshToken: string;

  try {
    accessToken = decryptToken(
      conn.access_token_encrypted
    );

    refreshToken = decryptToken(
      conn.refresh_token_encrypted
    );
  } catch (error) {
    console.error("GOOGLE TOKEN DECRYPTION FAILED:", {
      tenantId,
      error,
    });

    throw new Error("GOOGLE_TOKEN_DECRYPTION_FAILED");
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: conn.token_expiry
      ? new Date(conn.token_expiry).getTime()
      : undefined,
  });

  /**
   * Google automatically refreshes the access token when necessary.
   *
   * When Google gives us a new access token, persist it.
   *
   * IMPORTANT:
   * We intentionally preserve the existing refresh token.
   * Google often does NOT return a new refresh token during a
   * normal access-token refresh.
   */
  oauth2Client.on("tokens", async (tokens) => {
    try {
      const update: Record<string, any> = {};

      if (tokens.access_token) {
        update.access_token_encrypted =
          encryptToken(tokens.access_token);
      }

      if (tokens.expiry_date) {
        update.token_expiry =
          new Date(tokens.expiry_date).toISOString();
      }

      /**
       * Occasionally Google may issue a replacement refresh token.
       * If it does, persist it.
       */
      if (tokens.refresh_token) {
        update.refresh_token_encrypted =
          encryptToken(tokens.refresh_token);
      }

      if (Object.keys(update).length === 0) {
        return;
      }

      const { error } = await supabase
        .from("gmail_connections")
        .update(update)
        .eq("tenant_id", tenantId);

      if (error) {
        console.error(
          "GOOGLE TOKEN UPDATE FAILED:",
          {
            tenantId,
            error,
          }
        );
      } else {
        console.log(
          "GOOGLE ACCESS TOKEN REFRESHED:",
          {
            tenantId,
            expiresAt:
              tokens.expiry_date
                ? new Date(
                    tokens.expiry_date
                  ).toISOString()
                : undefined,
            refreshTokenReplaced:
              Boolean(tokens.refresh_token),
          }
        );
      }
    } catch (error) {
      /**
       * Never allow a database failure inside the token event
       * handler to crash the Google API request itself.
       */
      console.error(
        "GOOGLE TOKEN PERSISTENCE FAILED:",
        {
          tenantId,
          error,
        }
      );
    }
  });

  return oauth2Client;
}

/**
 * Mark a Google connection as requiring reauthentication.
 *
 * This is called when Google returns invalid_grant.
 *
 * IMPORTANT:
 * This function intentionally does not delete the entire
 * gmail_connections row. We want to preserve tenant-level
 * configuration such as calendar scope information and any
 * other connection metadata.
 */
export async function markGoogleReauthRequired(
  tenantId: string
) {
  const supabase = createServiceSupabase();

  const { error } = await supabase
    .from("gmail_connections")
    .update({
      google_reauth_required: true,
    })
    .eq("tenant_id", tenantId);

  if (error) {
    console.error(
      "FAILED TO MARK GOOGLE REAUTH REQUIRED:",
      {
        tenantId,
        error,
      }
    );

    return false;
  }

  console.warn(
    "GOOGLE CONNECTION MARKED FOR REAUTH:",
    {
      tenantId,
    }
  );

  return true;
}

/**
 * Clear the reauthentication flag after a successful
 * Google OAuth connection/reconnection.
 */
export async function clearGoogleReauthRequired(
  tenantId: string
) {
  const supabase = createServiceSupabase();

  const { error } = await supabase
    .from("gmail_connections")
    .update({
      google_reauth_required: false,
    })
    .eq("tenant_id", tenantId);

  if (error) {
    console.error(
      "FAILED TO CLEAR GOOGLE REAUTH FLAG:",
      {
        tenantId,
        error,
      }
    );

    return false;
  }

  console.log(
    "GOOGLE REAUTH FLAG CLEARED:",
    {
      tenantId,
    }
  );

  return true;
}

/**
 * Returns whether this tenant has Calendar permission recorded
 * on the shared Google OAuth connection.
 */
export async function tenantHasCalendarAccess(
  tenantId: string
): Promise<boolean> {
  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("gmail_connections")
    .select("calendar_scope_granted")
    .eq("tenant_id", tenantId)
    .single();

  if (error) {
    console.error(
      "CALENDAR ACCESS CHECK FAILED:",
      {
        tenantId,
        error,
      }
    );

    return false;
  }

  return data?.calendar_scope_granted ?? false;
}