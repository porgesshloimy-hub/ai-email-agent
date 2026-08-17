import { createServerSupabase } from "@/lib/supabase/server";
import { encryptToken, decryptToken } from "@/lib/crypto";

type ZoomConnection = {
  id: string;
  tenant_id: string;
  zoom_user_id: string;
  zoom_email: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expiry: string;
};

/**
 * Get the Zoom connection belonging to a tenant.
 */
async function getZoomConnection(
  tenantId: string
): Promise<ZoomConnection> {
  const supabase = await createServerSupabase();

  const { data, error } = await supabase
    .from("zoom_connections")
    .select(
      "id, tenant_id, zoom_user_id, zoom_email, access_token_encrypted, refresh_token_encrypted, token_expiry"
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    console.error("ZOOM CONNECTION LOOKUP FAILED:", {
      tenantId,
      error,
    });

    throw error;
  }

  if (!data) {
    throw new Error(
      `No Zoom connection found for tenant ${tenantId}`
    );
  }

  return data;
}

/**
 * Refresh a Zoom OAuth access token.
 *
 * Zoom access tokens expire, so we use the stored refresh token
 * to obtain a new access token when necessary.
 */
async function refreshZoomAccessToken(
  connection: ZoomConnection
): Promise<string> {
  const clientId =
    process.env.ZOOM_CLIENT_ID;

  const clientSecret =
    process.env.ZOOM_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "ZOOM_CLIENT_ID or ZOOM_CLIENT_SECRET is not configured"
    );
  }

  const refreshToken =
    decryptToken(
      connection.refresh_token_encrypted
    );

  console.log(
    "ZOOM TOKEN REFRESH START:",
    {
      tenantId: connection.tenant_id,
      zoomUserId: connection.zoom_user_id,
    }
  );

  const response = await fetch(
    "https://zoom.us/oauth/token",
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${clientId}:${clientSecret}`
          ).toString("base64"),

        "Content-Type":
          "application/x-www-form-urlencoded",
      },

      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    }
  );

  const tokenData =
    await response.json();

  if (!response.ok) {
    console.error(
      "ZOOM TOKEN REFRESH FAILED:",
      {
        tenantId: connection.tenant_id,
        status: response.status,
        responseData: tokenData,
      }
    );

    throw new Error(
      `Zoom token refresh failed: ${response.status}`
    );
  }

  if (
    !tokenData.access_token ||
    !tokenData.refresh_token
  ) {
    console.error(
      "ZOOM TOKEN REFRESH RETURNED INVALID DATA:",
      {
        tenantId: connection.tenant_id,
        tokenData: {
          ...tokenData,
          access_token: undefined,
          refresh_token: undefined,
        },
      }
    );

    throw new Error(
      "Zoom token refresh did not return required tokens"
    );
  }

  const encryptedAccessToken =
    encryptToken(
      tokenData.access_token
    );

  const encryptedRefreshToken =
    encryptToken(
      tokenData.refresh_token
    );

  const tokenExpiry =
    new Date(
      Date.now() +
        (tokenData.expires_in ?? 3600) *
          1000
    ).toISOString();

  const supabase =
    await createServerSupabase();

  const { error } =
    await supabase
      .from("zoom_connections")
      .update({
        access_token_encrypted:
          encryptedAccessToken,

        refresh_token_encrypted:
          encryptedRefreshToken,

        token_expiry:
          tokenExpiry,
      })
      .eq(
        "id",
        connection.id
      );

  if (error) {
    console.error(
      "ZOOM TOKEN SAVE AFTER REFRESH FAILED:",
      {
        tenantId:
          connection.tenant_id,
        error,
      }
    );

    throw error;
  }

  console.log(
    "ZOOM TOKEN REFRESH SUCCESS:",
    {
      tenantId:
        connection.tenant_id,
      zoomUserId:
        connection.zoom_user_id,
      tokenExpiry,
    }
  );

  return tokenData.access_token;
}

/**
 * Get a valid Zoom access token for a tenant.
 *
 * Refreshes the token automatically when it is expired
 * or about to expire.
 */
async function getZoomAccessToken(
  tenantId: string
): Promise<string> {
  const connection =
    await getZoomConnection(
      tenantId
    );

  const expiresAt =
    new Date(
      connection.token_expiry
    ).getTime();

  // Refresh five minutes before expiration.
  const refreshBuffer =
    5 * 60 * 1000;

  const shouldRefresh =
    Date.now() >=
    expiresAt - refreshBuffer;

  if (shouldRefresh) {
    return refreshZoomAccessToken(
      connection
    );
  }

  return decryptToken(
    connection.access_token_encrypted
  );
}

/**
 * Make an authenticated request to the Zoom API.
 */
async function zoomRequest<T>(
  tenantId: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  let accessToken =
    await getZoomAccessToken(
      tenantId
    );

  const url =
    `https://api.zoom.us/v2${path}`;

  console.log(
    "ZOOM API REQUEST:",
    {
      tenantId,
      path,
      method:
        options.method ?? "GET",
    }
  );

  let response =
    await fetch(url, {
      ...options,
      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        "Content-Type":
          "application/json",

        ...(options.headers ?? {}),
      },
    });

  /**
   * If Zoom says the token is unauthorized, refresh it once
   * and retry the request.
   *
   * This protects us against a token expiring between the
   * initial expiration check and the actual API request.
   */
  if (response.status === 401) {
    console.log(
      "ZOOM API TOKEN REJECTED — REFRESHING:",
      {
        tenantId,
        path,
      }
    );

    const connection =
      await getZoomConnection(
        tenantId
      );

    accessToken =
      await refreshZoomAccessToken(
        connection
      );

    response =
      await fetch(url, {
        ...options,
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          "Content-Type":
            "application/json",

          ...(options.headers ?? {}),
        },
      });
  }

  const responseText =
    await response.text();

  let responseData: unknown;

  try {
    responseData =
      responseText
        ? JSON.parse(responseText)
        : null;
  } catch {
    responseData =
      responseText;
  }

  if (!response.ok) {
    console.error(
      "ZOOM API REQUEST FAILED:",
      {
        tenantId,
        path,
        method:
          options.method ?? "GET",
        status:
          response.status,
        responseData,
      }
    );

    throw new Error(
      `Zoom API request failed: ${response.status}`
    );
  }

  console.log(
    "ZOOM API REQUEST SUCCESS:",
    {
      tenantId,
      path,
      status:
        response.status,
    }
  );

  return responseData as T;
}

/**
 * Get the currently authenticated Zoom user.
 *
 * Useful for testing the connection.
 */
export async function getZoomUser(
  tenantId: string
) {
  return zoomRequest<{
    id: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    type?: number;
  }>(
    tenantId,
    "/users/me"
  );
}

/**
 * Create a Zoom meeting for the connected user's
 * Zoom account.
 */
export async function createZoomMeeting(
  tenantId: string,
  meeting: {
    topic: string;
    startTime: string;
    durationMinutes: number;
    timezone?: string;
    agenda?: string;
  }
) {
  console.log(
    "ZOOM CREATE MEETING:",
    {
      tenantId,
      topic: meeting.topic,
      startTime:
        meeting.startTime,
      durationMinutes:
        meeting.durationMinutes,
      timezone:
        meeting.timezone,
    }
  );

  const result =
    await zoomRequest<{
      id: number;
      uuid: string;
      host_id: string;
      topic: string;
      start_time: string;
      duration: number;
      timezone?: string;
      join_url: string;
      start_url: string;
      password?: string;
    }>(
      tenantId,
      "/users/me/meetings",
      {
        method: "POST",

        body: JSON.stringify({
          topic:
            meeting.topic,

          type: 2,

          start_time:
            meeting.startTime,

          duration:
            meeting.durationMinutes,

          timezone:
            meeting.timezone,

          agenda:
            meeting.agenda,
        }),
      }
    );

  console.log(
    "ZOOM MEETING CREATED:",
    {
      tenantId,
      meetingId:
        result.id,
      topic:
        result.topic,
      joinUrl:
        result.join_url,
      startTime:
        result.start_time,
    }
  );

  return result;
}