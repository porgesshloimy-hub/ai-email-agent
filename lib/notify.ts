import twilio from "twilio";
import { createServiceSupabase } from "@/lib/supabase/server";
import { recordUsage } from "@/lib/billing/meter";
import { calculateSmsCost } from "@/lib/billing/pricing";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSms(
  tenantId: string,
  phoneNumber: string,
  message: string
) {
  const sent = await client.messages.create({
    to: phoneNumber,
    from: process.env.TWILIO_FROM_NUMBER,
    body: message,
  });

  const segments = Number(
    sent.numSegments ?? "1"
  );

  await recordUsage({
    tenantId,
    service: "twilio_sms",
    description: "Owner notification SMS",
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

  await sendSms(
    tenantId,
    tenant.phone_number,
    `${message}\n\nReply APPROVE to approve or DENY to reject.`
  );
}