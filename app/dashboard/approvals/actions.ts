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

  const { createEvent } = await import("@/lib/calendar/client");
  const event = await createEvent(action.tenant_id, {
    summary: action.proposed_summary,
    startTime: action.proposed_start,
    endTime: action.proposed_end,
  });

  await supabase
    .from("calendar_actions")
    .update({ status: "sent", google_event_id: event.id, resolved_at: new Date().toISOString() })
    .eq("id", actionId);

  revalidatePath("/dashboard/approvals");
}

/**
 * The Zoom equivalent of confirmCalendarEvent — this is the ONLY place
 * that actually calls Zoom's create-meeting endpoint for a proposal that
 * required approval (i.e. calendar_actions rows with
 * action_type "create_zoom_meeting", inserted by propose_zoom_meeting in
 * the agent pipeline). Same ownership-check pattern as the other two.
 *
 * ASSUMPTION FLAGGED: this writes zoom_meeting_id and zoom_join_url onto
 * the calendar_actions row. If those columns don't exist yet on your
 * table, this insert/update will fail — you'll need a migration adding
 * them (both nullable text columns) before this works.
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
    // Note: timezone and agenda were not captured at proposal time
    // (propose_zoom_meeting doesn't store them on calendar_actions),
    // so Zoom will fall back to its account default timezone here.
  });

  await supabase
    .from("calendar_actions")
    .update({
      status: "sent",
      zoom_meeting_id: String(zoomMeeting.id),
      zoom_join_url: zoomMeeting.join_url,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", actionId);

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