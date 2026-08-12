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
  createGoogleMeet?: boolean;
}

export async function listUpcomingEvents(
  tenantId: string,
  maxResults = 10
) {
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

export async function findAvailability(
  tenantId: string,
  timeMinISO: string,
  timeMaxISO: string
) {
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
 * Creates a calendar event.
 *
 * Important:
 * - attendees are added to the event
 * - sendUpdates: "all" explicitly asks Google Calendar to send
 *   invitation emails to all attendees
 * - when createGoogleMeet is true, Google Calendar also requests
 *   creation of a Google Meet conference
 */
export async function createEvent(
  tenantId: string,
  input: CalendarEventInput
) {
  const calendar = await getCalendarClient(tenantId);

  const attendeeEmails = (input.attendeeEmails ?? [])
    .map((email) => email.trim())
    .filter(Boolean);

  const shouldCreateMeet =
    input.createGoogleMeet === true;

  const requestBody: any = {
    summary: input.summary,

    description: input.description,

    start: {
      dateTime: input.startTime,
    },

    end: {
      dateTime: input.endTime,
    },

    attendees: attendeeEmails.map((email) => ({
      email,
    })),
  };

  /**
   * Request a real Google Meet conference when requested.
   *
   * A unique requestId prevents Google from confusing this
   * conference request with another event.
   */
  if (shouldCreateMeet) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: `prime-automatic-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`,
        conferenceSolutionKey: {
          type: "hangoutsMeet",
        },
      },
    };
  }

  console.log("GOOGLE CALENDAR CREATE EVENT:", {
    tenantId,
    summary: input.summary,
    startTime: input.startTime,
    endTime: input.endTime,
    attendeeEmails,
    shouldCreateMeet,
    sendUpdates: "all",
  });

  const event = await calendar.events.insert({
    calendarId: "primary",

    /**
     * This is the important part for invitation emails.
     *
     * Google documents that "all" sends notifications to
     * all guests.
     */
    sendUpdates: "all",

    /**
     * Required when creating Google Meet conference data.
     */
    conferenceDataVersion: shouldCreateMeet ? 1 : 0,

    requestBody,
  });

  /**
   * Log exactly what Google returned.
   *
   * This lets us verify in production that Google actually
   * registered the attendee and whether the attendee is in
   * needsAction/accepted/etc. state.
   */
  console.log("GOOGLE CALENDAR EVENT CREATED:", {
    tenantId,
    googleEventId: event.data.id,
    htmlLink: event.data.htmlLink,
    status: event.data.status,

    attendees: event.data.attendees?.map((attendee) => ({
      email: attendee.email,
      responseStatus: attendee.responseStatus,
      organizer: attendee.organizer,
      self: attendee.self,
    })),

    conferenceStatus:
      event.data.conferenceData?.createRequest?.status,

    conferenceEntryPoints:
      event.data.conferenceData?.entryPoints?.map(
        (entryPoint) => ({
          entryPointType:
            entryPoint.entryPointType,
          uri: entryPoint.uri,
        })
      ),
  });

  /**
   * Cache the event so the agent can reference it later.
   */
  const supabase = createServiceSupabase();

  const { error: cacheError } = await supabase
    .from("calendar_events_cache")
    .insert({
      tenant_id: tenantId,
      google_event_id: event.data.id,
      summary: input.summary,
      start_time: input.startTime,
      end_time: input.endTime,
      created_by: "agent",
    });

  if (cacheError) {
    console.error(
      "CALENDAR EVENT CACHE FAILED:",
      {
        tenantId,
        googleEventId: event.data.id,
        error: cacheError,
      }
    );

    /**
     * Do NOT treat this as a Calendar creation failure.
     *
     * The Google Calendar event was already successfully created.
     */
  }

  return event.data;
}

export async function updateEvent(
  tenantId: string,
  googleEventId: string,
  updates: Partial<CalendarEventInput>
) {
  const calendar = await getCalendarClient(tenantId);

  const requestBody: any = {};

  if (updates.summary !== undefined) {
    requestBody.summary = updates.summary;
  }

  if (updates.description !== undefined) {
    requestBody.description = updates.description;
  }

  if (updates.startTime !== undefined) {
    requestBody.start = {
      dateTime: updates.startTime,
    };
  }

  if (updates.endTime !== undefined) {
    requestBody.end = {
      dateTime: updates.endTime,
    };
  }

  /**
   * Preserve attendee changes if updateEvent is ever expanded
   * to accept them.
   */
  if (updates.attendeeEmails !== undefined) {
    requestBody.attendees =
      updates.attendeeEmails
        .map((email) => email.trim())
        .filter(Boolean)
        .map((email) => ({
          email,
        }));
  }

  const event = await calendar.events.patch({
    calendarId: "primary",
    eventId: googleEventId,

    /**
     * Make sure attendees receive notification of changes.
     */
    sendUpdates: "all",

    requestBody,
  });

  return event.data;
}

export async function deleteEvent(
  tenantId: string,
  googleEventId: string
) {
  const calendar = await getCalendarClient(tenantId);

  await calendar.events.delete({
    calendarId: "primary",
    eventId: googleEventId,

    /**
     * Notify attendees that the event was cancelled.
     */
    sendUpdates: "all",
  });

  const supabase = createServiceSupabase();

  await supabase
    .from("calendar_events_cache")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("google_event_id", googleEventId);
}