import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client();

const CHAT_ISSUER = "chat@system.gserviceaccount.com";

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
    console.error("Google Chat: GOOGLE_CHAT_AUDIENCE is not configured");
    return false;
  }

  try {
    // Decode only for diagnostics. This does NOT establish trust.
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf8")
      );

      console.log("Google Chat token claims:", {
        issuer: payload.iss,
        audience: payload.aud,
        email: payload.email,
        email_verified: payload.email_verified,
        expiration: payload.exp,
      });
    }

    console.log("Google Chat expected audience:", audience);

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