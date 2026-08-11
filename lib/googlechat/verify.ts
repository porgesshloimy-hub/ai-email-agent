import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client();

const CHAT_ISSUER = "chat@system.gserviceaccount.com";

/**
 * Verifies requests sent by Google Chat.
 *
 * Google Chat is configured with:
 * Authentication Audience = HTTP endpoint URL
 *
 * In this configuration, Google sends a Google-signed OIDC ID token.
 */
export async function verifyGoogleChatRequest(
  authHeader: string | null
): Promise<boolean> {
  console.log("=== GOOGLE CHAT VERIFY FUNCTION CALLED ===");

  // Check for Authorization header
  if (!authHeader) {
    console.error("Google Chat: No Authorization header received");
    return false;
  }

  if (!authHeader.startsWith("Bearer ")) {
    console.error("Google Chat: Authorization header is not Bearer");
    return false;
  }

  const token = authHeader.slice("Bearer ".length);

  // Get expected audience from Vercel environment variables
  const audience = process.env.GOOGLE_CHAT_AUDIENCE;

  if (!audience) {
    console.error(
      "Google Chat: GOOGLE_CHAT_AUDIENCE environment variable is missing"
    );
    return false;
  }

  console.log("Google Chat expected audience:", audience);

  try {
    /*
     * Decode the JWT payload ONLY for diagnostics.
     *
     * This does NOT establish trust.
     * The actual security verification happens below with verifyIdToken().
     *
     * We deliberately do NOT log the actual token.
     */
    const parts = token.split(".");

    if (parts.length === 3) {
      try {
        const decodedPayload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf8")
        );

        console.log("=== GOOGLE CHAT JWT CLAIMS ===");
        console.log({
          issuer: decodedPayload.iss,
          audience: decodedPayload.aud,
          email: decodedPayload.email,
          email_verified: decodedPayload.email_verified,
          expiration: decodedPayload.exp,
          issued_at: decodedPayload.iat,
        });
        console.log("=== END GOOGLE CHAT JWT CLAIMS ===");
      } catch (decodeError) {
        console.error(
          "Google Chat: Could not decode JWT payload for diagnostics:",
          decodeError
        );
      }
    } else {
      console.error(
        "Google Chat: Authorization token does not appear to be a JWT"
      );
    }

    /*
     * This is the actual security verification.
     *
     * For HTTP endpoint URL authentication, Google Chat's token
     * audience must match the configured HTTP endpoint URL.
     */
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience,
    });

    const payload = ticket.getPayload();

    console.log("=== GOOGLE CHAT TOKEN VERIFIED ===");
    console.log({
      issuer: payload?.iss,
      audience: payload?.aud,
      email: payload?.email,
      email_verified: payload?.email_verified,
    });
    console.log("=== END GOOGLE CHAT TOKEN VERIFIED ===");

    // Make sure the verified token really belongs to Google Chat.
    if (payload?.email !== CHAT_ISSUER) {
      console.error(
        "Google Chat: Unexpected token email:",
        payload?.email
      );
      return false;
    }

    if (payload.email_verified !== true) {
      console.error(
        "Google Chat: Token email is not verified"
      );
      return false;
    }

    console.log("=== GOOGLE CHAT REQUEST AUTHORIZED ===");

    return true;
  } catch (err) {
    console.error(
      "=== GOOGLE CHAT REQUEST VERIFICATION FAILED ==="
    );
    console.error(err);

    return false;
  }
}