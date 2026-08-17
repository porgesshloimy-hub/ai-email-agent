import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import crypto from "crypto";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

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

  const clientId = process.env.ZOOM_CLIENT_ID;

  if (!clientId) {
    console.error("ZOOM_CLIENT_ID is not configured");

    return new NextResponse(
      "ZOOM_CLIENT_ID is not configured",
      { status: 500 }
    );
  }

  // Generate a cryptographically secure OAuth state value.
  const state = crypto.randomBytes(32).toString("hex");

  const redirectUri =
    `${requestUrl.origin}/api/auth/zoom/callback`;

  const zoomAuthUrl = new URL(
    "https://zoom.us/oauth/authorize"
  );

  zoomAuthUrl.searchParams.set(
    "response_type",
    "code"
  );

  zoomAuthUrl.searchParams.set(
    "client_id",
    clientId
  );

  zoomAuthUrl.searchParams.set(
    "redirect_uri",
    redirectUri
  );

  zoomAuthUrl.searchParams.set(
    "state",
    state
  );

  const response = NextResponse.redirect(
    zoomAuthUrl.toString()
  );

  // Store the OAuth state in an HTTP-only cookie so the
  // callback can verify that this OAuth request originated
  // from the current Prime Automatic session.
  response.cookies.set("zoom_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });

  return response;
}