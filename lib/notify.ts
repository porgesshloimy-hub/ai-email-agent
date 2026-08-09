import twilio from "twilio";
import { createServiceSupabase } from "@/lib/supabase/server";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * SMS is notification-only — the owner never approves by replying to the
 * text. Approval happens in the dashboard, so there's no inbound-SMS
 * parsing/security surface to build or maintain.
 */
export async function notifyOwner(tenantId: string, message: string) {
  const supabase = createServiceSupabase();
  const { data: tenant } = await supabase.from("tenants").select("phone_number").eq("id", tenantId).single();

  if (!tenant?.phone_number) return;

  await client.messages.create({
    to: tenant.phone_number,
    from: process.env.TWILIO_FROM_NUMBER,
    body: `${message}\nReview: ${process.env.NEXT_PUBLIC_APP_URL}/dashboard/approvals`,
  });
}
