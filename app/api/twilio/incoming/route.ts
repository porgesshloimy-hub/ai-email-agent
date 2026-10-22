import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { createServiceSupabase } from "@/lib/supabase/server";
import { sendDraft } from "@/lib/gmail/client";
import { checkAndResolveAcknowledgment } from "@/lib/agent/reminders/ack-detection";
import { persistChatMessage } from "@/lib/agent/chat-history/persist";
import { inngest } from "@/lib/inngest/client";
import { recordUsage } from "@/lib/billing/meter";
import { calculateSmsCost } from "@/lib/billing/pricing";
import {
  isValidTwilioRequest,
  normalizePhoneNumber,
} from "@/lib/sms/twilio";

/**
 * Longest inbound text accepted. SMS itself caps well below this once
 * concatenated; the limit just keeps one oversized or malicious POST
 * from becoming an oversized LLM prompt.
 */
const MAX_INBOUND_CHARS = 1600;

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  /**
   * Twilio signs the exact set of form fields it sent, so validation
   * needs all of them as plain strings. Done BEFORE anything reads
   * `From`: without this check, anyone who knew this URL could POST a
   * forged `From` equal to the owner's number and run APPROVE/DENY or
   * talk to the agent as the owner. Fails closed (see
   * isValidTwilioRequest).
   */
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === "string") params[key] = value;
  });

  // The address this request actually arrived on — only a last-resort
  // fallback when no webhook URL is configured (see
  // getInboundWebhookUrl). Behind Vercel, x-forwarded-host/proto carry
  // the public values.
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const requestDerivedUrl = forwardedHost
    ? `${forwardedProto}://${forwardedHost}${request.nextUrl.pathname}${request.nextUrl.search}`
    : undefined;

  if (
    !isValidTwilioRequest(
      request.headers.get("x-twilio-signature"),
      params,
      requestDerivedUrl
    )
  ) {
    console.error("TWILIO INBOUND: invalid or missing signature, rejected");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const rawFrom = String(params.From ?? "").trim();
  const from = normalizePhoneNumber(rawFrom) ?? rawFrom;

  // Kept in original casing/punctuation for the reminder-acknowledgment
  // check and for the agent (natural language, not an exact command
  // comparison) — `body` (uppercased) below is still what every exact
  // command check compares against, unchanged.
  const rawBody = String(params.Body ?? "")
    .trim()
    .slice(0, MAX_INBOUND_CHARS);
  const body = rawBody.toUpperCase();

  if (!from) {
    return emptyTwimlResponse();
  }

  /**
   * An owner can have more than one authorized phone: the primary
   * (tenants.phone_number) or any entry in
   * tenants.additional_phone_numbers (migration 022).
   */
  const tenantId = await findTenantIdByPhone(from);

  if (tenantId === "error") {
    return twimlResponse(
      "There was a problem processing your request. Please try again."
    );
  }

  if (!tenantId) {
    // Deliberately NO reply to an unrecognized number. Answering every
    // stranger who texts this number costs money per message and lets
    // anyone use it as an SMS amplifier; silence is the safe default.
    console.log("TWILIO INBOUND: message from an unrecognized number, ignored");
    return emptyTwimlResponse();
  }

  // Inbound texts cost real money on Twilio's side; meter them like the
  // outbound ones. Never blocks handling the message.
  try {
    const inboundSegments = Math.max(1, Number(params.NumSegments ?? "1") || 1);

    await recordUsage({
      tenantId,
      service: "twilio_sms",
      description: "Owner inbound SMS",
      quantity: inboundSegments,
      unit: "sms_segment",
      rawCostUsd: calculateSmsCost(inboundSegments),
    });
  } catch (error) {
    console.error("TWILIO INBOUND: failed to record inbound SMS usage:", error, {
      tenantId,
    });
  }

  if (!body) {
    return twimlResponse(
      "I can only read text messages right now — send me words and I'll take it from there."
    );
  }

  const tenant = { id: tenantId };

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

  /*
   * Reminder acknowledgment (Phase 3.3) — checked only after none of the
   * exact commands above matched, so "APPROVE"/"DENY"/etc. keep taking
   * priority over this. checkAndResolveAcknowledgment itself only acts
   * when exactly one reminder is currently awaiting_ack for this tenant
   * (see its own module comment for why it deliberately doesn't guess
   * when more than one is pending) and fails closed on any error, so a
   * false positive here can't silently clear a reminder that wasn't
   * actually acknowledged.
   */
  const acknowledgedReminder = await checkAndResolveAcknowledgment(tenant.id, rawBody);

  if (acknowledgedReminder) {
    return twimlResponse(`Got it — cleared that reminder: "${acknowledgedReminder.content}"`);
  }

  /*
   * Everything else is a conversation with the agent. Previously this
   * fell through to "I didn't understand that"; now SMS is simply
   * another transport for the same owner chat the dashboard widget
   * uses: persist the message, hand it to the same Inngest reply
   * pipeline (channel "sms" has no typing signal, so it skips the wait
   * phases and answers as fast as the backend can — see
   * lib/agent/chat-pacing.ts), and let that pipeline text the answer
   * back to `replyToPhone` (lib/inngest/functions.ts).
   *
   * The reply deliberately does NOT go back through this response:
   * Twilio gives a webhook ~15 seconds, an LLM turn with tools can take
   * longer, and a timeout would drop the answer. Returning an empty
   * TwiML response now and sending via the REST API later avoids that.
   */
  const row = await persistChatMessage(tenant.id, "owner", rawBody, "sms");

  if (!row) {
    return twimlResponse("Sorry — I couldn't save that message. Please send it again.");
  }

  try {
    await inngest.send({
      name: "chat/owner-message.sent",
      data: {
        tenantId: tenant.id,
        ownerMessageId: row.id,
        ownerMessageCreatedAt: row.created_at,
        channel: "sms",
        replyToPhone: from,
      },
    });
  } catch (error) {
    console.error("TWILIO INBOUND: failed to queue agent reply:", error, {
      tenantId: tenant.id,
    });

    return twimlResponse(
      "I got your message but couldn't start working on it. Please try again in a minute."
    );
  }

  return emptyTwimlResponse();
}

/**
 * Looks up which tenant, if any, an inbound number belongs to — primary
 * number first, then the additional authorized numbers. Returns
 * "error" for a lookup failure so the caller can tell that apart from
 * "no such number" (which must stay silent).
 */
async function findTenantIdByPhone(
  phone: string
): Promise<string | null | "error"> {
  const supabase = createServiceSupabase();

  const { data: primary, error: primaryError } = await supabase
    .from("tenants")
    .select("id")
    .eq("phone_number", phone)
    .maybeSingle();

  if (primaryError) {
    console.error("Tenant lookup failed:", primaryError);
    return "error";
  }

  if (primary) return primary.id;

  const { data: additional, error: additionalError } = await supabase
    .from("tenants")
    .select("id")
    .contains("additional_phone_numbers", [phone])
    .limit(1)
    .maybeSingle();

  if (additionalError) {
    console.error("Tenant lookup (additional numbers) failed:", additionalError);
    return "error";
  }

  return additional?.id ?? null;
}

/**
 * A valid TwiML response that sends nothing back to the texter.
 */
function emptyTwimlResponse() {
  return new NextResponse(new twilio.twiml.MessagingResponse().toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
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