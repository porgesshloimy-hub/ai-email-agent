"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";

/**
 * This is the ONLY place in the whole app where a gated "send" actually
 * happens. It requires an authenticated dashboard request from the tenant's
 * own owner — never triggered by the agent pipeline directly.
 */
export async function approveAndSend(formData: FormData) {
  const actionId = formData.get("actionId") as string;

  const userSupabase = await createServerSupabase();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const supabase = createServiceSupabase();

  const { data: action } = await supabase
    .from("email_actions")
    .select("*, tenants!inner(owner_user_id)")
    .eq("id", actionId)
    .single();

  // Ownership check — never trust the client-submitted actionId alone.
  if (!action || (action as any).tenants.owner_user_id !== user.id) {
    throw new Error("Not authorized to approve this draft");
  }

  if (action.action_type !== "draft_reply" || !action.gmail_draft_id) {
    throw new Error("This action is not a pending email draft and cannot be sent.");
  }

  const { sendDraft } = await import("@/lib/gmail/client");
  await sendDraft(action.tenant_id, action.gmail_draft_id);

  await supabase
    .from("email_actions")
    .update({ status: "sent", resolved_at: new Date().toISOString() })
    .eq("id", actionId);

  revalidatePath("/dashboard/approvals");
}

export async function rejectDraft(formData: FormData) {
  const actionId = formData.get("actionId") as string;

  const userSupabase = await createServerSupabase();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const supabase = createServiceSupabase();
  const { data: action } = await supabase
    .from("email_actions")
    .select("*, tenants!inner(owner_user_id)")
    .eq("id", actionId)
    .single();

  if (!action || (action as any).tenants.owner_user_id !== user.id) {
    throw new Error("Not authorized to reject this draft");
  }

  if (action.gmail_draft_id) {
    const { deleteDraft } = await import("@/lib/gmail/client");
    await deleteDraft(action.tenant_id, action.gmail_draft_id);
  }

  await supabase
    .from("email_actions")
    .update({ status: "rejected", resolved_at: new Date().toISOString() })
    .eq("id", actionId);

  revalidatePath("/dashboard/approvals");
}

/**
 * Sends the agent's pre-written confirmation email for an approved
 * Zoom meeting or calendar event.
 *
 * IMPORTANT: this does NOT call the AI agent live. The confirmation
 * text was already written by the model back when it proposed the
 * meeting (see propose_zoom_meeting / propose_calendar_event in
 * lib/agent/run.ts) and stored verbatim in
 * calendar_actions.draft_confirmation_body. Approving here only
 * substitutes the real meeting link into the {{meeting_link}}
 * placeholder and sends it — no new model call, no new AI cost, and no
 * risk of the agent "acting live" at approval time.
 *
 * A failure to send this confirmation email does NOT roll back or fail
 * the approval — the Zoom meeting / calendar event has already been
 * created for real by this point, so the meeting itself must not be
 * lost just because the follow-up email failed. The failure is logged
 * loudly instead.
 */
async function sendStoredConfirmation(
  action: {
    tenant_id: string;
    customer_email: string | null;
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
    gmail_subject: string | null;
    proposed_summary: string | null;
    draft_confirmation_body: string | null;
  },
  meetingLink: string | null,
  actionId: string
) {
  if (
    !action.customer_email ||
    !action.gmail_thread_id ||
    !action.draft_confirmation_body
  ) {
    console.error(
      "SKIPPING CONFIRMATION EMAIL — MISSING DATA ON calendar_actions ROW:",
      {
        actionId,
        tenantId: action.tenant_id,
        hasCustomerEmail: Boolean(action.customer_email),
        hasThreadId: Boolean(action.gmail_thread_id),
        hasConfirmationBody: Boolean(action.draft_confirmation_body),
      }
    );

    return;
  }

  try {
    const { createDraft, sendDraft } = await import("@/lib/gmail/client");

    const finalBody = meetingLink
      ? action.draft_confirmation_body.replace(
          /\{\{meeting_link\}\}/g,
          meetingLink
        )
      : action.draft_confirmation_body;

    const draft = await createDraft(
  action.tenant_id,
  action.gmail_thread_id,
  action.customer_email,
  `Re: ${action.gmail_subject ?? action.proposed_summary ?? "Your meeting"}`,
  finalBody,
  action.gmail_message_id ?? undefined
);

    if (!draft.id) {
      throw new Error("Gmail did not return a draft ID for the confirmation email");
    }

    await sendDraft(action.tenant_id, draft.id);
  } catch (notifyError) {
    // The meeting/event is already created and saved — a failed
    // customer notification must not undo or fail the approval.
    console.error(
      "CONFIRMATION EMAIL FAILED — MEETING/EVENT WAS STILL CREATED:",
      {
        actionId,
        tenantId: action.tenant_id,
        error: notifyError,
      }
    );
  }
}

/**
 * The calendar equivalent of approveAndSend — this is the ONLY place that
 * actually calls Google Calendar's create-event endpoint for a
 * proposal that required approval. Same ownership-check pattern as email.
 *
 * Guards against action_type "create_zoom_meeting" rows — those must go
 * through confirmZoomMeeting instead, since they need the Zoom API, not
 * Google Calendar.
 */
export async function confirmCalendarEvent(formData: FormData) {
  const actionId = formData.get("actionId") as string;

  const userSupabase = await createServerSupabase();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const supabase = createServiceSupabase();
  const { data: action } = await supabase
    .from("calendar_actions")
    .select("*, tenants!inner(owner_user_id)")
    .eq("id", actionId)
    .single();

  if (!action || (action as any).tenants.owner_user_id !== user.id) {
    throw new Error("Not authorized to confirm this event");
  }

  if (action.action_type === "create_zoom_meeting") {
    throw new Error("This is a Zoom meeting proposal — use confirmZoomMeeting, not confirmCalendarEvent.");
  }

  // Idempotency guard — mirrors the pattern in processIncomingEmail.
  // Without this, a silently-failed update below could let a second
  // click create a second, duplicate Calendar event for the same
  // proposal, and send a second confirmation email.
  if (action.status === "sent") {
    console.log("CALENDAR EVENT ALREADY CONFIRMED:", { actionId });
    return;
  }

  const { createEvent, getGoogleMeetUrl } = await import("@/lib/calendar/client");
  const event = await createEvent(action.tenant_id, {
    summary: action.proposed_summary,
    startTime: action.proposed_start,
    endTime: action.proposed_end,
    attendeeEmails: action.attendee_emails ?? [],
  });

  const { error: updateError } = await supabase
    .from("calendar_actions")
    .update({
      status: "sent",
      google_event_id: event.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", actionId);

  if (updateError) {
    console.error(
      "FAILED TO RECORD CALENDAR EVENT — EVENT WAS CREATED BUT DB UPDATE FAILED:",
      {
        actionId,
        tenantId: action.tenant_id,
        googleEventId: event.id,
        error: updateError,
      }
    );

    throw new Error(
      `Calendar event was created (ID: ${event.id}) but could not be saved: ${updateError.message}`
    );
  }

  await sendStoredConfirmation(
    action,
    getGoogleMeetUrl(event),
    actionId
  );

  revalidatePath("/dashboard/approvals");
}

/**
 * The Zoom equivalent of confirmCalendarEvent — this is the ONLY place
 * that actually calls Zoom's create-meeting endpoint for a proposal that
 * required approval (i.e. calendar_actions rows with
 * action_type "create_zoom_meeting", inserted by propose_zoom_meeting in
 * the agent pipeline). Same ownership-check pattern as the other two.
 */
export async function confirmZoomMeeting(formData: FormData) {
  const actionId = formData.get("actionId") as string;

  const userSupabase = await createServerSupabase();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const supabase = createServiceSupabase();
  const { data: action } = await supabase
    .from("calendar_actions")
    .select("*, tenants!inner(owner_user_id)")
    .eq("id", actionId)
    .single();

  if (!action || (action as any).tenants.owner_user_id !== user.id) {
    throw new Error("Not authorized to confirm this meeting");
  }

  if (action.action_type !== "create_zoom_meeting") {
    throw new Error("This is not a Zoom meeting proposal — use confirmCalendarEvent instead.");
  }

  // Idempotency guard — mirrors the pattern in processIncomingEmail.
  // Without this, a silently-failed update below could let a second
  // click create a second, duplicate Zoom meeting for the same
  // proposal, and send a second confirmation email.
  if (action.status === "sent") {
    console.log("ZOOM MEETING ALREADY CONFIRMED:", { actionId });
    return;
  }

  const durationMinutes = Math.round(
    (new Date(action.proposed_end).getTime() - new Date(action.proposed_start).getTime()) / 60000
  );

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error("Could not determine a valid meeting duration from the stored proposal.");
  }

  const { createZoomMeeting } = await import("@/lib/zoom/client");
  const zoomMeeting = await createZoomMeeting(action.tenant_id, {
    topic: action.proposed_summary,
    startTime: action.proposed_start,
    durationMinutes,
  });

  /**
   * Approving a Zoom proposal also places it on Google Calendar.
   *
   * The account holder has just explicitly approved this specific time
   * by clicking Approve, so there's no remaining judgment call about
   * whether a calendar event is warranted — unlike the live agent path
   * (create_zoom_meeting during processIncomingEmail), which still has
   * to decide that for itself.
   *
   * A failure here does NOT fail the whole approval — the Zoom meeting
   * already exists and the customer will still get their confirmation
   * email either way. It's logged loudly instead so it can be added to
   * the calendar manually if needed.
   */
  let googleEventId: string | null = null;

  try {
    const { createEvent } = await import("@/lib/calendar/client");

    const calendarEvent = await createEvent(action.tenant_id, {
      summary: action.proposed_summary,
      description: `Zoom meeting: ${zoomMeeting.join_url}`,
      startTime: action.proposed_start,
      endTime: action.proposed_end,
      attendeeEmails: action.customer_email ? [action.customer_email] : [],
      createGoogleMeet: false,
    });

    googleEventId = calendarEvent.id ?? null;
  } catch (calendarError) {
    console.error(
      "FAILED TO CREATE MATCHING CALENDAR EVENT — ZOOM MEETING WAS STILL CREATED:",
      {
        actionId,
        tenantId: action.tenant_id,
        zoomMeetingId: zoomMeeting.id,
        error: calendarError,
      }
    );
  }

  const { error: updateError } = await supabase
    .from("calendar_actions")
    .update({
      status: "sent",
      zoom_meeting_id: String(zoomMeeting.id),
      zoom_join_url: zoomMeeting.join_url,
      google_event_id: googleEventId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", actionId);

  if (updateError) {
    console.error("FAILED TO RECORD ZOOM MEETING — MEETING WAS CREATED BUT DB UPDATE FAILED:", {
      actionId,
      tenantId: action.tenant_id,
      zoomMeetingId: zoomMeeting.id,
      zoomJoinUrl: zoomMeeting.join_url,
      error: updateError,
    });

    throw new Error(
      `Zoom meeting was created (ID: ${zoomMeeting.id}) but could not be saved: ${updateError.message}`
    );
  }

  await sendStoredConfirmation(
    action,
    zoomMeeting.join_url,
    actionId
  );

  revalidatePath("/dashboard/approvals");
}

export async function dismissCalendarEvent(formData: FormData) {
  const actionId = formData.get("actionId") as string;

  const userSupabase = await createServerSupabase();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const supabase = createServiceSupabase();
  const { data: action } = await supabase
    .from("calendar_actions")
    .select("*, tenants!inner(owner_user_id)")
    .eq("id", actionId)
    .single();

  if (!action || (action as any).tenants.owner_user_id !== user.id) {
    throw new Error("Not authorized to dismiss this event");
  }

  await supabase
    .from("calendar_actions")
    .update({ status: "rejected", resolved_at: new Date().toISOString() })
    .eq("id", actionId);

  revalidatePath("/dashboard/approvals");
}