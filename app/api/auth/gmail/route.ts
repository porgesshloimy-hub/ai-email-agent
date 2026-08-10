import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { createServerSupabase } from "@/lib/supabase/server";

// Scopes requested for the AGENT's Gmail access (separate from account login).
// Keep this list as narrow as the product actually needs — broader scopes mean
// a heavier Google security review (CASA) before you can scale past test users.
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose", // draft creation
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify", // archive/labels
];

export async function GET(req: NextRequest) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token
    prompt: "consent", // force refresh_token on repeat connects
    scope: GMAIL_SCOPES,
    state: user.id, // used in the callback to tie the tokens back to this user's tenant
  });

  return NextResponse.redirect(authUrl);
}
