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