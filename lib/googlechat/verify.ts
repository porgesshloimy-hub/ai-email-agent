import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client();

/**
 * Google Chat signs every request to your bot's endpoint with a bearer JWT
 * in the Authorization header. Verifying it (audience = your GCP project
 * number, issuer = chat@system.gserviceaccount.com) is what stops anyone
 * else from POSTing fake messages to this endpoint and impersonating a
 * tenant's chat.
 */
export async function verifyGoogleChatRequest(authHeader: string | null): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CHAT_PROJECT_NUMBER,
    });
    const payload = ticket.getPayload();
    return payload?.email === "chat@system.gserviceaccount.com" && payload.email_verified === true;
  } catch (err) {
    console.error("Google Chat request verification failed:", err);
    return false;
  }
}
