import twilio from "twilio";

/**
 * Single home for everything Twilio-specific that more than one file
 * needs: whether it's actually configured, a lazily-created client,
 * phone-number normalization, and inbound-webhook signature validation.
 *
 * Why lazy: lib/notify.ts and the inbound webhook used to build the
 * Twilio client at module load. With the credentials unset (this
 * deployment's real state until now), that is a failure at import time
 * rather than at the one call that needs it, and it hid the real
 * problem — "Twilio isn't configured" — behind whichever error the
 * client happened to throw. Everything here defers that to first use.
 */

/**
 * True only when every credential an outbound send needs is really
 * present in the environment — same idea as isProviderConfigured() for
 * LLM keys in lib/agent/llm. A tenant having a phone_number on file says
 * nothing about whether Twilio can actually send; callers must check
 * this too before choosing SMS over a fallback channel.
 */
export function isTwilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER
  );
}

let cachedClient: ReturnType<typeof twilio> | null = null;

export function getTwilioClient(): ReturnType<typeof twilio> {
  if (!isTwilioConfigured()) {
    throw new Error(
      "Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER)."
    );
  }

  if (!cachedClient) {
    cachedClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }

  return cachedClient;
}

/**
 * Normalizes user-entered US/Canada numbers to E.164 ("+15551234567"),
 * which is the format Twilio puts in the inbound `From` field. Accepts
 * "(555) 123-4567", "555-123-4567", "1 555 123 4567", "+1 555 123 4567".
 * Returns null for anything that isn't clearly a valid number rather
 * than guessing — a wrongly-normalized number here would authorize the
 * wrong phone to control the account.
 */
export function normalizePhoneNumber(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hasPlus) {
    // Already international. E.164 is at most 15 digits, at least 8.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return null;
}

/**
 * The exact public URL Twilio was configured to call. Signature
 * validation signs this URL, and behind Vercel/a custom domain the
 * request's own `url` isn't reliably the same string Twilio used, so it
 * is built from configuration instead. TWILIO_WEBHOOK_URL overrides it
 * outright for unusual setups.
 */
export function getInboundWebhookUrl(requestDerivedUrl?: string): string {
  const override = cleanEnvValue(process.env.TWILIO_WEBHOOK_URL);

  if (isAbsoluteUrl(override)) {
    return override;
  }

  const base = cleanEnvValue(process.env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, "");
  const configured = `${base}/api/twilio/incoming`;

  if (isAbsoluteUrl(configured)) {
    return configured;
  }

  /**
   * Neither variable gave a usable absolute URL (the failure that
   * produced "Invalid URL" in production: NEXT_PUBLIC_APP_URL was empty,
   * leaving just "/api/twilio/incoming"). Fall back to the address this
   * very request arrived on. That is safe: the URL is only one input
   * to an HMAC that cannot be produced without TWILIO_AUTH_TOKEN, so a
   * forged Host header can't make a forged request validate — it would
   * simply fail the comparison. Explicit configuration still wins
   * whenever it's present and valid.
   */
  if (requestDerivedUrl && isAbsoluteUrl(requestDerivedUrl)) {
    console.error(
      "TWILIO SIGNATURE: no usable TWILIO_WEBHOOK_URL / NEXT_PUBLIC_APP_URL configured — using the request's own address instead. Set TWILIO_WEBHOOK_URL to make this explicit:",
      { requestDerivedUrl }
    );
    return requestDerivedUrl;
  }

  return configured;
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\/[^/\s]+/i.test(value);
}

/**
 * Environment values pasted into a dashboard routinely pick up a
 * trailing space/newline or wrapping quotes. For most variables that
 * is harmless; for anything that feeds a signature comparison it makes
 * every request fail with no visible reason. Trim whitespace and strip
 * one pair of matching surrounding quotes.
 */
function cleanEnvValue(value: string | undefined): string {
  let v = (value ?? "").trim();

  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }

  return v;
}

/**
 * Verifies a request really came from Twilio, using the
 * X-Twilio-Signature header and the account auth token.
 *
 * Without this, the inbound webhook trusted whatever `From` value
 * anyone chose to POST at it — meaning anyone who knew the URL could
 * impersonate the owner's phone and, for example, send APPROVE. With
 * SMS becoming a primary control surface, that is no longer acceptable.
 *
 * Fails CLOSED: missing token, missing header, or a mismatch all
 * return false. The only bypass is outside production, for local
 * testing, via TWILIO_SKIP_SIGNATURE_VALIDATION=true; it is ignored
 * when NODE_ENV is "production".
 */
export function isValidTwilioRequest(
  signatureHeader: string | null,
  params: Record<string, string>,
  requestDerivedUrl?: string
): boolean {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.TWILIO_SKIP_SIGNATURE_VALIDATION === "true"
  ) {
    return true;
  }

  const authToken = cleanEnvValue(process.env.TWILIO_AUTH_TOKEN);

  if (!authToken || !signatureHeader) {
    console.error("TWILIO SIGNATURE: cannot validate —", {
      authTokenPresent: Boolean(authToken),
      signatureHeaderPresent: Boolean(signatureHeader),
    });
    return false;
  }

  const url = getInboundWebhookUrl(requestDerivedUrl);

  if (!isAbsoluteUrl(url)) {
    console.error(
      "TWILIO SIGNATURE: the webhook URL is not an absolute http(s) URL, so no request can be validated. Set TWILIO_WEBHOOK_URL (e.g. https://yourdomain.com/api/twilio/incoming):",
      { urlUsed: url }
    );
    return false;
  }

  try {
    const valid = twilio.validateRequest(
      authToken,
      signatureHeader,
      url,
      params
    );

    if (!valid) {
      logSignatureMismatch(authToken, signatureHeader, url, params);
    }

    return valid;
  } catch (error) {
    console.error("TWILIO SIGNATURE VALIDATION ERROR:", error);
    return false;
  }
}

/**
 * Logged only when a signature does NOT match, to make the cause
 * findable from the deployment logs instead of guesswork. Nothing
 * secret is written: not the token (only its length, which helps spot
 * a truncated paste) and only the first few characters of each
 * signature (enough to confirm "these differ" without handing anyone a
 * usable value).
 *
 * How to read it:
 *   - urlUsed: the exact string being signed against. It must equal
 *     what the Twilio console calls, character for character.
 *   - urlSource: which variable it came from.
 *   - expectedPrefix vs receivedPrefix: always differ here; what
 *     matters is everything else.
 *   - paramKeys: the form fields Twilio sent.
 *   - tokenLength: a real Twilio Auth Token is 32 characters.
 */
function logSignatureMismatch(
  authToken: string,
  receivedSignature: string,
  url: string,
  params: Record<string, string>
) {
  let expectedPrefix = "unavailable";

  try {
    expectedPrefix = twilio
      .getExpectedTwilioSignature(authToken, url, params)
      .slice(0, 6);
  } catch {
    // diagnostic only
  }

  console.error("TWILIO SIGNATURE MISMATCH:", {
    urlUsed: url,
    urlSource: cleanEnvValue(process.env.TWILIO_WEBHOOK_URL)
      ? "TWILIO_WEBHOOK_URL"
      : "NEXT_PUBLIC_APP_URL",
    tokenLength: authToken.length,
    expectedPrefix,
    receivedPrefix: receivedSignature.slice(0, 6),
    paramKeys: Object.keys(params).sort(),
  });
}
