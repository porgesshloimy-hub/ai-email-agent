import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client();

// Google Workspace Add-on service account used by this Chat app.
const CHAT_ISSUER =
  "service-199996239511@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";

/**
 * Verifies requests sent by Google Chat / Google Workspace Add-ons.
 *
 * The Chat app is configured with:
 * Authentication Audience = HTTP endpoint URL
 *
 * Google sends a Google-signed OIDC ID token.
 */
export async function verifyGoogleChatRequest(
  authHeader: string | null
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) {
    console.error("Google Chat: Missing or invalid Authorization header");
    return false;
  }

  const token = authHeader.slice("Bearer ".length);
  const audience = process.env.GOOGLE_CHAT_AUDIENCE;

  if (!audience) {
    console.error(
      "Google Chat: GOOGLE_CHAT_AUDIENCE environment variable is missing"
    );
    return false;
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience,
    });

    const payload = ticket.getPayload();

    console.log("Google Chat token verified:", {
      issuer: payload?.iss,
      audience: payload?.aud,
      email: payload?.email,
      email_verified: payload?.email_verified,
    });

    return (
      payload?.email === CHAT_ISSUER &&
      payload.email_verified === true
    );
  } catch (err) {
    console.error("Google Chat request verification failed:", err);
    return false;
  }
}