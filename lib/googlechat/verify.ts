import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client();

const CHAT_ISSUER = "chat@system.gserviceaccount.com";

export async function verifyGoogleChatRequest(
  authHeader: string | null
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) {
    console.error("Google Chat: Missing Authorization header");
    return false;
  }

  const token = authHeader.slice("Bearer ".length);
  const audience = process.env.GOOGLE_CHAT_AUDIENCE;

  if (!audience) {
    console.error("GOOGLE_CHAT_AUDIENCE is not configured");
    return false;
  }

  try {
    // Diagnostic only — do not log the token itself.
    const parts = token.split(".");

    if (parts.length === 3) {
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf8")
      );

      console.log("GOOGLE CHAT JWT DEBUG:", {
        issuer: payload.iss,
        audience: payload.aud,
        email: payload.email,
        email_verified: payload.email_verified,
        expectedAudience: audience,
      });
    }

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