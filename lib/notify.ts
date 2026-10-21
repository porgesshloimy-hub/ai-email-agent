import { createServiceSupabase } from "@/lib/supabase/server";
import { recordUsage } from "@/lib/billing/meter";
import { calculateSmsCost } from "@/lib/billing/pricing";
import { getTwilioClient, isTwilioConfigured } from "@/lib/sms/twilio";

/**
 * Twilio concatenates long messages up to 1,600 characters; beyond that
 * the API rejects the send outright. Agent replies are written for chat
 * and can run long, so anything over this is trimmed and pointed at the
 * dashboard, where the full text is always stored.
 */
const MAX_SMS_CHARS = 1500;

function fitSmsLength(message: string): string {
  if (message.length <= MAX_SMS_CHARS) return message;

  const suffix = "\n…(full reply in your dashboard chat)";
  return message.slice(0, MAX_SMS_CHARS - suffix.length).trimEnd() + suffix;
}

async function sendSms(
  tenantId: string,
  phoneNumber: string,
  message: string,
  description = "Owner notification SMS"
) {
  const sent = await getTwilioClient().messages.create({
    to: phoneNumber,
    from: process.env.TWILIO_FROM_NUMBER,
    body: fitSmsLength(message),
  });

  const segments = Number(
    sent.numSegments ?? "1"
  );

  await recordUsage({
    tenantId,
    service: "twilio_sms",
    description,
    quantity: segments,
    unit: "sms_segment",
    rawCostUsd: calculateSmsCost(segments),
  });
}

export async function notifyOwner(
  tenantId: string,
  message: string
) {
  const supabase =
    createServiceSupabase();

  const { data: tenant } =
    await supabase
      .from("tenants")
      .select("phone_number")
      .eq("id", tenantId)
      .single();

  if (!tenant?.phone_number) {
    return;
  }

  // A phone number on file doesn't mean Twilio can send — see
  // isTwilioConfigured(). Skip loudly rather than throw an opaque
  // Twilio client error from inside an approval flow.
  if (!isTwilioConfigured()) {
    console.error("NOTIFY OWNER: Twilio is not configured, SMS skipped:", { tenantId });
    return;
  }

  await sendSms(
    tenantId,
    tenant.phone_number,
    `${message}\nReview: ${process.env.NEXT_PUBLIC_APP_URL}/dashboard/approvals`
  );
}

/**
 * Plain owner SMS send — no hardcoded "Review: .../dashboard/approvals"
 * link appended (unlike notifyOwner, which is specifically for approval-
 * adjacent notifications). Added for lib/agent/outreach/dispatcher.ts
 * (Phase 5.2): a reminder or watch notification isn't about anything
 * pending approval, so appending that link would be actively misleading.
 * Returns whether the send actually happened (true) or was skipped
 * because the tenant has no phone number on file, or failed outright
 * (false either way) — the dispatcher uses this to decide whether to
 * count the attempt or leave the item queued for a real retry.
 */
export async function sendOwnerMessage(
  tenantId: string,
  message: string
): Promise<boolean> {
  const supabase = createServiceSupabase();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("phone_number")
    .eq("id", tenantId)
    .single();

  if (!tenant?.phone_number) {
    console.error("SEND OWNER MESSAGE: no phone number on file, skipping:", { tenantId });
    return false;
  }

  if (!isTwilioConfigured()) {
    console.error("SEND OWNER MESSAGE: Twilio is not configured, skipping:", { tenantId });
    return false;
  }

  try {
    await sendSms(tenantId, tenant.phone_number, message);
    return true;
  } catch (error) {
    console.error("SEND OWNER MESSAGE: send failed:", error, { tenantId });
    return false;
  }
}

/**
 * Sends an SMS asking the owner to approve or
 * reject the most recent pending action.
 */
export async function notifyApproval(
  tenantId: string,
  approvalId: string,
  message: string
) {
  const supabase =
    createServiceSupabase();

  const { data: tenant } =
    await supabase
      .from("tenants")
      .select("phone_number")
      .eq("id", tenantId)
      .single();

  if (!tenant?.phone_number) {
    return;
  }

  if (!isTwilioConfigured()) {
    console.error("NOTIFY APPROVAL: Twilio is not configured, SMS skipped:", { tenantId });
    return;
  }

  await sendSms(
    tenantId,
    tenant.phone_number,
    `${message}\n\nReply APPROVE to approve or DENY to reject.`
  );
}

/**
 * Sends one SMS to a specific number — used to answer the owner on the
 * same phone they just texted from (they may have more than one
 * authorized number; see tenants.additional_phone_numbers, migration
 * 022). Returns whether it really went out; never throws, so callers
 * can decide what a failure means for them.
 */
export async function sendSmsToNumber(
  tenantId: string,
  phoneNumber: string,
  message: string,
  description: string
): Promise<boolean> {
  if (!isTwilioConfigured()) {
    console.error("SEND SMS TO NUMBER: Twilio is not configured, skipping:", { tenantId });
    return false;
  }

  try {
    await sendSms(tenantId, phoneNumber, message, description);
    return true;
  } catch (error) {
    console.error("SEND SMS TO NUMBER: send failed:", error, { tenantId });
    return false;
  }
}