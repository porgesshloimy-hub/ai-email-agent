import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client();

const CHAT_ISSUER = "chat@system.gserviceaccount.com";

/**
 * Google Chat sends a Google-signed OIDC ID token
 * when Authentication Audience is set to HTTP endpoint URL.
 */
export async function verifyGoogleChatRequest(
  authHeader: string | null
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.slice("Bearer ".length);
  const audience = process.env.GOOGLE_CHAT_AUDIENCE;

  if (!audience) {
    console.error("GOOGLE_CHAT_AUDIENCE is not configured");
    return false;
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience,
    });

    const payload = ticket.getPayload();

    return (
      payload?.email === CHAT_ISSUER &&
      payload.email_verified === true
    );
  } catch (err) {
    console.error("Google Chat request verification failed:", err);
    return false;
  }
}