import { NextResponse } from "next/server";
import crypto from "crypto";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

  const redirectUri =
    `${requestUrl.origin}/api/auth/google/callback`;

  const state = crypto.randomBytes(32).toString("hex");

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

  response.cookies.set("google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });

  return response;
}