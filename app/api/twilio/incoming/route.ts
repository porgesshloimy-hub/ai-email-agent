import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { createServiceSupabase } from "@/lib/supabase/server";
import { sendDraft } from "@/lib/gmail/client";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const from = String(formData.get("From") ?? "").trim();
  const body = String(formData.get("Body") ?? "")
    .trim()
    .toUpperCase();

  if (!from) {
    return twimlResponse("Unable to identify your phone number.");
  }

  if (!body) {
    return twimlResponse(
      "Reply APPROVE or DENY to handle your pending approval."
    );
  }

  const supabase = createServiceSupabase();

  // Find the tenant belonging to this phone number.
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id")
    .eq("phone_number", from)
    .maybeSingle();

  if (tenantError) {
    console.error("Tenant lookup failed:", tenantError);
    return twimlResponse(
      "There was a problem processing your request. Please try again."
    );
  }

  if (!tenant) {
    return twimlResponse(
      "This phone number is not connected to a Prime Automatic account."
    );
  }

  /*
   * APPROVE / DENY
   *
   * For now, these operate on the most recent pending approval.
   */
  if (body === "APPROVE") {
    return handleApprove(tenant.id);
  }

  if (body === "DENY") {
    return handleDeny(tenant.id);
  }

  /*
   * Allow simple permission changes by SMS.
   */
  if (
    body === "ALLOW SEND" ||
    body === "DENY SEND" ||
    body === "REQUIRE APPROVAL SEND"
  ) {
    return handleSendPermission(
      tenant.id,
      body
    );
  }

  return twimlResponse(
    "I didn't understand that. Reply APPROVE or DENY for your latest pending approval."
  );
}

/**
 * APPROVE
 */
async function handleApprove(tenantId: string) {
  const supabase = createServiceSupabase();

  const { data: approval, error } = await supabase
    .from("approvals")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Approval lookup failed:", error);

    return twimlResponse(
      "There was a problem finding your pending approval."
    );
  }

  if (!approval) {
    return twimlResponse(
      "You don't have any pending approvals."
    );
  }

  /*
   * Only Gmail approvals are executed here for now.
   */
  if (approval.action_type !== "gmail.send") {
    return twimlResponse(
      "That approval type isn't ready for SMS approval yet. Please use the dashboard."
    );
  }

  /*
   * Atomically claim the approval.
   *
   * This prevents the same approval from being
   * executed twice if two APPROVE messages arrive.
   */
  const { data: claimedApproval, error: claimError } =
    await supabase
      .from("approvals")
      .update({
        status: "approved",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", approval.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();

  if (claimError) {
    console.error(
      "Failed to claim approval:",
      claimError
    );

    return twimlResponse(
      "I couldn't approve that action. Please try again."
    );
  }

  if (!claimedApproval) {
    return twimlResponse(
      "That approval was already handled. Please check your dashboard."
    );
  }

  /*
   * The approval's action_id points to email_actions.id.
   */
  const { data: emailAction, error: actionError } =
    await supabase
      .from("email_actions")
      .select(
        "id, gmail_draft_id, status, draft_content"
      )
      .eq("id", approval.action_id)
      .eq("tenant_id", tenantId)
      .single();

  if (actionError || !emailAction) {
    console.error(
      "Email action lookup failed:",
      actionError
    );

    /*
     * We claimed the approval but couldn't execute it.
     * Put it back into the pending state so the owner
     * can try again rather than losing the approval.
     */
    await supabase
      .from("approvals")
      .update({
        status: "pending",
        resolved_at: null,
      })
      .eq("id", approval.id);

    return twimlResponse(
      "I couldn't find the email draft. The approval is still pending."
    );
  }

  if (!emailAction.gmail_draft_id) {
    await supabase
      .from("approvals")
      .update({
        status: "pending",
        resolved_at: null,
      })
      .eq("id", approval.id);

    return twimlResponse(
      "The email draft is missing. The approval is still pending."
    );
  }

  /*
   * Don't send an action that has already been sent.
   */
  if (emailAction.status === "sent") {
    return twimlResponse(
      "That email has already been sent."
    );
  }

  try {
    await sendDraft(
      tenantId,
      emailAction.gmail_draft_id
    );

    await supabase
      .from("email_actions")
      .update({
        status: "sent",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", emailAction.id);

    return twimlResponse(
      "Approved. The email has been sent."
    );
  } catch (error) {
    console.error(
      "Failed to send approved Gmail draft:",
      error
    );

    /*
     * Sending failed, so don't permanently consume
     * the approval.
     */
    await supabase
      .from("approvals")
      .update({
        status: "pending",
        resolved_at: null,
      })
      .eq("id", approval.id);

    return twimlResponse(
      "I couldn't send the email. The approval is still pending."
    );
  }
}

/**
 * DENY
 */
async function handleDeny(tenantId: string) {
  const supabase = createServiceSupabase();

  const { data: approval, error } = await supabase
    .from("approvals")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Approval lookup failed:", error);

    return twimlResponse(
      "There was a problem finding your pending approval."
    );
  }

  if (!approval) {
    return twimlResponse(
      "You don't have any pending approvals."
    );
  }

  const { error: updateError } = await supabase
    .from("approvals")
    .update({
      status: "rejected",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", approval.id)
    .eq("status", "pending");

  if (updateError) {
    console.error(
      "Failed to reject approval:",
      updateError
    );

    return twimlResponse(
      "I couldn't reject that approval. Please try again."
    );
  }

  if (approval.action_type === "gmail.send") {
    await supabase
      .from("email_actions")
      .update({
        status: "rejected",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", approval.action_id)
      .eq("tenant_id", tenantId);
  }

  return twimlResponse(
    "Denied. The email will not be sent."
  );
}

/**
 * Change Gmail send permission by SMS.
 */
async function handleSendPermission(
  tenantId: string,
  command: string
) {
  const supabase = createServiceSupabase();

  let level:
    | "allowed"
    | "denied"
    | "approval_required";

  if (command === "ALLOW SEND") {
    level = "allowed";
  } else if (command === "DENY SEND") {
    level = "denied";
  } else {
    level = "approval_required";
  }

  const { error } = await supabase
    .from("agent_permissions")
    .upsert(
      {
        tenant_id: tenantId,
        action: "gmail.send",
        level,
      },
      {
        onConflict: "tenant_id,action",
      }
    );

  if (error) {
    console.error(
      "Failed to update send permission:",
      error
    );

    return twimlResponse(
      "I couldn't update the send permission."
    );
  }

  if (level === "allowed") {
    return twimlResponse(
      "Done. The AI may now send approved emails automatically."
    );
  }

  if (level === "denied") {
    return twimlResponse(
      "Done. The AI is no longer allowed to send emails."
    );
  }

  return twimlResponse(
    "Done. Email sending now requires your approval."
  );
}

/**
 * Twilio expects TwiML XML.
 */
function twimlResponse(message: string) {
  const response =
    new twilio.twiml.MessagingResponse();

  response.message(message);

  return new NextResponse(
    response.toString(),
    {
      status: 200,
      headers: {
        "Content-Type": "text/xml",
      },
    }
  );
}