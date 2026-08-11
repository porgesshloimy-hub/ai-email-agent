import { NextResponse } from "next/server";
import crypto from "crypto";

export async function GET() {
  const state = crypto.randomBytes(32).toString("hex");

  // Always use the canonical production URL so the OAuth
  // redirect URI does not change depending on which hostname
  // the user happened to visit.
  const redirectUri =
    "https://www.primeautomatic.com/api/auth/google/callback";

  const scopes = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
  ].join(" ");

  const googleUrl = new URL(
    "https://accounts.google.com/o/oauth2/v2/auth"
  );

  googleUrl.searchParams.set(
    "client_id",
    process.env.GOOGLE_CLIENT_ID!
  );
  googleUrl.searchParams.set(
    "redirect_uri",
    redirectUri
  );
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", scopes);
  googleUrl.searchParams.set("access_type", "offline");
  googleUrl.searchParams.set("prompt", "consent");
  googleUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(googleUrl);

  // Store the OAuth state in a secure cookie so the callback
  // can verify that this is the same OAuth flow we started.
  response.cookies.set("google_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });

  return response;
}