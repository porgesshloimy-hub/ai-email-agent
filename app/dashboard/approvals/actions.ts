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
 * SAFETY CHECKS (added — this function previously ran none at all):
 * this is the one place a proposal's stored text actually reaches a
 * customer, potentially days after the model wrote it, with no human
 * re-reading it first (approving is a decision about the MEETING, not
 * a proofread of the email). Before sending:
 *
 * 1. Substitute {{meeting_link}} as before.
 * 2. Run the same stripKnownSafePlaceholders/detectHallucinatedContent
 *    checks lib/agent/run.ts's live loop already applies to
 *    send_reply/create_draft — with allowMeetingLinkPlaceholder: false,
 *    since by this point substitution has already been attempted, so a
 *    surviving {{meeting_link}} means it failed (e.g. no real link was
 *    available — see confirmCalendarEvent's createGoogleMeet fix
 *    below), not that it's still pending.
 * 3. Run the same grounding check lib/agent/grounding-guard.ts applies
 *    live, using the ONE capability that was just actually fulfilled
 *    (`capability`, passed in by the caller) as both the available and
 *    completed set — this only flags a claim that goes beyond
 *    confirming the specific meeting/event that was actually just
 *    created, it does not re-relitigate that meeting itself.
 *
 * A violation at this point does NOT roll back or fail the approval —
 * the Zoom meeting / calendar event has already been created for real
 * by this point, so the meeting itself must not be lost. The
 * confirmation send is skipped and logged loudly instead, the same way
 * a Gmail API failure here was already handled, so the owner can see
 * it in logs and follow up manually.
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
  actionId: string,
  capability: "zoom" | "calendar"
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
    const { checkReplyIsGrounded } = await import("@/lib/agent/grounding-guard");
    const {
      stripKnownSafePlaceholders,
      detectHallucinatedContent,
    } = await import("@/lib/agent/content-safety");

    let finalBody = meetingLink
      ? action.draft_confirmation_body.replace(
          /\{\{meeting_link\}\}/g,
          meetingLink
        )
      : action.draft_confirmation_body;

    finalBody = stripKnownSafePlaceholders(finalBody);

    const deterministicViolation = detectHallucinatedContent(
      finalBody,
      // If this confirmation is for a Zoom meeting, a real Zoom action
      // just happened, so legitimate mentions of Zoom are expected —
      // treat zoomCapability as "write" so the zoom-specific branch
      // doesn't fire. If this confirmation is for a plain calendar
      // event, no Zoom action happened at all, so any mention of Zoom
      // here would be exactly the kind of fabrication this check
      // exists to catch — treat zoomCapability as "none" so it does
      // fire.
      { zoomCapability: capability === "zoom" ? "write" : "none" },
      { allowMeetingLinkPlaceholder: false }
    );

    if (deterministicViolation) {
      console.error(
        "CONFIRMATION EMAIL BLOCKED — CONTENT SAFETY CHECK FAILED:",
        {
          actionId,
          tenantId: action.tenant_id,
          capability,
          violation: deterministicViolation,
        }
      );

      return;
    }

    const groundingResult = await checkReplyIsGrounded({
      replyText: finalBody,
      availableCapabilities: [capability],
      completedCapabilities: [capability],
    });

    if (!groundingResult.ok) {
      console.error("CONFIRMATION EMAIL BLOCKED — GROUNDING CHECK FAILED:", {
        actionId,
        tenantId: action.tenant_id,
        capability,
        source: groundingResult.source,
        violations: groundingResult.violations,
        error: groundingResult.error,
      });

      return;
    }

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
 * Bug fix (2026-08-21): propose_calendar_event and propose_zoom_meeting
 * (lib/agent/tools/propose-calendar-event.ts,
 * lib/agent/tools/propose-zoom-meeting.ts) each write a MIRROR row into
 * email_actions — action_type "calendar_proposal", status
 * "pending_approval" — alongside the real proposal row in
 * calendar_actions. That mirror row exists only so the dashboard's
 * pending count and the email idempotency guard have something to point
 * at; the actual actionable proposal a human resolves lives entirely in
 * calendar_actions.
 *
 * confirmCalendarEvent/confirmZoomMeeting/dismissCalendarEvent below
 * only ever updated the calendar_actions row — never this email_actions
 * mirror. Every single calendar/Zoom proposal ever approved or
 * dismissed left its mirror row stuck at status "pending_approval"
 * forever, with no code path that would ever change it again. Those
 * stuck rows are invisible on the approvals page (it only queries
 * email_actions rows with action_type "draft_reply" — see
 * app/dashboard/approvals/page.tsx), but the dashboard's pending count
 * (app/dashboard/page.tsx) counted ALL "pending_approval" rows
 * regardless of action_type — hence: dashboard says "8 waiting," the
 * approvals page shows nothing, because those 8 were never draft
 * replies at all, just permanently-orphaned mirrors of long-since
 * resolved calendar/Zoom proposals.
 *
 * Fix, two parts:
 * 1. (this function) — resolve the mirror row alongside the real one,
 *    every time a proposal is confirmed or dismissed, so this stops
 *    happening for every future proposal.
 * 2. (app/dashboard/page.tsx) — count what's actually shown on the
 *    approvals page (draft_reply pending + calendar_actions pending),
 *    not "any pending_approval row regardless of type," so an
 *    already-orphaned row (or any other future mismatch) can never
 *    inflate the badge again even if something else drifts.
 * A one-time cleanup for rows already stuck from before this fix still
 * needs to be run once directly in Supabase — see the accompanying SQL.
 *
 * Matches by (tenant_id, gmail_thread_id, gmail_message_id) rather than
 * a stored foreign key, since calendar_actions has no column linking
 * back to the email_actions row that spawned it. This is a best-effort
 * match, not a guaranteed one-to-one link — acceptable here because the
 * mirror row's only remaining purpose after this fix is to not
 * permanently inflate a count; a missed match just leaves the old
 * behavior (harmless once the dashboard also filters by action_type).
 */
async function resolveMirroredEmailAction(
  supabase: ReturnType<typeof createServiceSupabase>,
  action: {
    tenant_id: string;
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
  },
  newStatus: "sent" | "rejected"
) {
  if (!action.gmail_thread_id || !action.gmail_message_id) {
    return;
  }

  const { data: updated, error } = await supabase
    .from("email_actions")
    .update({
      status: newStatus,
      resolved_at: new Date().toISOString(),
    })
    .eq("tenant_id", action.tenant_id)
    .eq("gmail_thread_id", action.gmail_thread_id)
    .eq("gmail_message_id", action.gmail_message_id)
    .eq("action_type", "calendar_proposal")
    .eq("status", "pending_approval")
    .select("id");

  if (error) {
    // Never fail the real approval/dismissal over this — it's a count
    // hygiene fix, not the actual business action.
    console.error("FAILED TO RESOLVE MIRRORED EMAIL ACTION:", {
      tenantId: action.tenant_id,
      gmailThreadId: action.gmail_thread_id,
      gmailMessageId: action.gmail_message_id,
      error,
    });

    return;
  }

  console.log("MIRRORED EMAIL ACTION RESOLVED:", {
    tenantId: action.tenant_id,
    gmailThreadId: action.gmail_thread_id,
    newStatus,
    rowsUpdated: updated?.length ?? 0,
  });
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

  /**
   * BUG FIX: this call previously never passed createGoogleMeet at
   * all, so it always defaulted to false — no Google Meet conference
   * was ever created for an approved calendar proposal. But
   * propose_calendar_event's own tool description explicitly tells the
   * model it may write the {{meeting_link}} placeholder into
   * confirmationMessage "if a link is expected". Since meetingLink
   * below is getGoogleMeetUrl(event), and no Meet was ever requested,
   * meetingLink was always null here — and sendStoredConfirmation's
   * substitution only runs `if (meetingLink)`, so a stored confirmation
   * containing {{meeting_link}} was sent to the customer with that
   * literal placeholder text still in it. This is the same class of
   * failure as the live-agent Zoom incident, just via the approval
   * path instead. Fix: only request a Meet when the stored confirmation
   * actually expects a link, so a real one exists to substitute.
   */
  const needsMeetingLink = /\{\{meeting_link\}\}/.test(
    action.draft_confirmation_body ?? ""
  );

  const event = await createEvent(action.tenant_id, {
    summary: action.proposed_summary,
    startTime: action.proposed_start,
    endTime: action.proposed_end,
    attendeeEmails: action.attendee_emails ?? [],
    createGoogleMeet: needsMeetingLink,
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

  await resolveMirroredEmailAction(supabase, action, "sent");

  await sendStoredConfirmation(
    action,
    getGoogleMeetUrl(event),
    actionId,
    "calendar"
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

  await resolveMirroredEmailAction(supabase, action, "sent");

  await sendStoredConfirmation(
    action,
    zoomMeeting.join_url,
    actionId,
    "zoom"
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

  await resolveMirroredEmailAction(supabase, action, "rejected");

  revalidatePath("/dashboard/approvals");
}