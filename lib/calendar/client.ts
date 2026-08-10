import { google } from "googleapis";
import { getGoogleAuthedClient } from "@/lib/google/authClient";
import { createServiceSupabase } from "@/lib/supabase/server";

async function getCalendarClient(tenantId: string) {
  const auth = await getGoogleAuthedClient(tenantId);
  return google.calendar({ version: "v3", auth });
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  attendeeEmails?: string[];
}

export async function listUpcomingEvents(tenantId: string, maxResults = 10) {
  const calendar = await getCalendarClient(tenantId);
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });
  return res.data.items ?? [];
}

export async function findAvailability(tenantId: string, timeMinISO: string, timeMaxISO: string) {
  const calendar = await getCalendarClient(tenantId);
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: "primary" }],
    },
  });
  return res.data.calendars?.primary?.busy ?? [];
}

/**
 * Creates a calendar event and caches its id so the agent can reference it
 * later (e.g. to update or cancel) without another round trip to find it.
 */
export async function createEvent(tenantId: string, input: CalendarEventInput) {
  const calendar = await getCalendarClient(tenantId);

  const event = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startTime },
      end: { dateTime: input.endTime },
      attendees: input.attendeeEmails?.map((email) => ({ email })),
    },
  });

  const supabase = createServiceSupabase();
  await supabase.from("calendar_events_cache").insert({
    tenant_id: tenantId,
    google_event_id: event.data.id,
    summary: input.summary,
    start_time: input.startTime,
    end_time: input.endTime,
    created_by: "agent",
  });

  return event.data;
}

export async function updateEvent(
  tenantId: string,
  googleEventId: string,
  updates: Partial<CalendarEventInput>
) {
  const calendar = await getCalendarClient(tenantId);
  const event = await calendar.events.patch({
    calendarId: "primary",
    eventId: googleEventId,
    requestBody: {
      summary: updates.summary,
      description: updates.description,
      start: updates.startTime ? { dateTime: updates.startTime } : undefined,
      end: updates.endTime ? { dateTime: updates.endTime } : undefined,
    },
  });
  return event.data;
}

export async function deleteEvent(tenantId: string, googleEventId: string) {
  const calendar = await getCalendarClient(tenantId);
  await calendar.events.delete({ calendarId: "primary", eventId: googleEventId });

  const supabase = createServiceSupabase();
  await supabase
    .from("calendar_events_cache")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("google_event_id", googleEventId);
}
