import { google } from "googleapis";
import { getGoogleAuthedClient } from "@/lib/google/authClient";
import { createServiceSupabase } from "@/lib/supabase/server";

async function getCalendarClient(tenantId: string) {
  const auth = await getGoogleAuthedClient(tenantId);

  return google.calendar({
    version: "v3",
    auth,
  });
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  attendeeEmails?: string[];

  /**
   * When true, Google Calendar will create a real
   * Google Meet conference for the event.
   *
   * IMPORTANT:
   * Permission enforcement for whether the agent is allowed
   * to request a Meet should happen in the agent/permissions
   * layer before calling createEvent().
   */
  createGoogleMeet?: boolean;
}

/**
 * Return the Google Meet URL from a Calendar event, if one exists.
 *
 * Google may return the Meet URL in conferenceData.entryPoints.
 */
export function getGoogleMeetUrl(
  event: any
): string | null {
  const entryPoints =
    event?.conferenceData?.entryPoints ?? [];

  const videoEntryPoint = entryPoints.find(
    (entryPoint: any) =>
      entryPoint?.entryPointType === "video" &&
      typeof entryPoint?.uri === "string"
  );

  return videoEntryPoint?.uri ?? null;
}

/**
 * List upcoming calendar events.
 */
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

/**
 * Find calendar availability.
 */
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
 * Creates a Google Calendar event.
 *
 * Supports:
 *
 * - regular calendar events
 * - attendees
 * - invitation emails
 * - Google Meet conferences
 *
 * Permission decisions should happen BEFORE this function is called.
 *
 * For example:
 *
 *   createGoogleMeet: false
 *
 * creates a normal Calendar event.
 *
 *   createGoogleMeet: true
 *
 * creates a Calendar event with a real Google Meet conference.
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

  /**
   * Build the Calendar event.
   */
  const requestBody: any = {
    summary: input.summary,

    ...(input.description
      ? {
          description: input.description,
        }
      : {}),

    start: {
      dateTime: input.startTime,
    },

    end: {
      dateTime: input.endTime,
    },

    /**
     * Only include attendees when there actually
     * are attendees.
     */
    ...(attendeeEmails.length > 0
      ? {
          attendees: attendeeEmails.map((email) => ({
            email,
          })),
        }
      : {}),
  };

  /**
   * Google Meet
   *
   * Google Calendar creates the actual Meet conference
   * through conferenceData.createRequest.
   *
   * conferenceDataVersion: 1 is required on the API request.
   */
  if (shouldCreateMeet) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: `prime-automatic-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 12)}`,

        conferenceSolutionKey: {
          type: "hangoutsMeet",
        },
      },
    };
  }

  console.log(
    "GOOGLE CALENDAR CREATE EVENT:",
    {
      tenantId,
      summary: input.summary,
      startTime: input.startTime,
      endTime: input.endTime,
      attendeeEmails,
      createGoogleMeet: shouldCreateMeet,
    }
  );

  /**
   * Create the Calendar event.
   *
   * sendUpdates: "all"
   * tells Google to send invitation emails to attendees.
   *
   * conferenceDataVersion:
   *   1 when creating a Meet
   *   0 for normal Calendar events
   */
  const event = await calendar.events.insert({
    calendarId: "primary",

    sendUpdates: "all",

    conferenceDataVersion: shouldCreateMeet
      ? 1
      : 0,

    requestBody,
  });

  const googleMeetUrl = getGoogleMeetUrl(
    event.data
  );

  /**
   * Log the important information returned by Google.
   */
  console.log(
    "GOOGLE CALENDAR EVENT CREATED:",
    {
      tenantId,

      googleEventId: event.data.id,

      htmlLink: event.data.htmlLink,

      status: event.data.status,

      summary: event.data.summary,

      start: event.data.start,

      end: event.data.end,

      attendees:
        event.data.attendees?.map(
          (attendee) => ({
            email: attendee.email,
            responseStatus:
              attendee.responseStatus,
            organizer: attendee.organizer,
            self: attendee.self,
          })
        ),

      createGoogleMeet: shouldCreateMeet,

      googleMeetUrl,

      conferenceStatus:
        event.data.conferenceData
          ?.createRequest
          ?.status,

      conferenceEntryPoints:
        event.data.conferenceData
          ?.entryPoints
          ?.map((entryPoint) => ({
            entryPointType:
              entryPoint.entryPointType,
            uri: entryPoint.uri,
          })),
    }
  );

  /**
   * Cache the event so the agent can reference it later.
   *
   * We intentionally do not make a failed cache write
   * turn a successful Google Calendar operation into
   * a failure.
   */
  if (event.data.id) {
    const supabase =
      createServiceSupabase();

    const { error: cacheError } =
      await supabase
        .from("calendar_events_cache")
        .insert({
          tenant_id: tenantId,
          google_event_id:
            event.data.id,
          summary: input.summary,
          start_time:
            input.startTime,
          end_time:
            input.endTime,
          created_by: "agent",
        });

    if (cacheError) {
      console.error(
        "CALENDAR EVENT CACHE FAILED:",
        {
          tenantId,
          googleEventId:
            event.data.id,
          error: cacheError,
        }
      );
    }
  }

  /**
   * Return Google's complete event response.
   *
   * The caller can use:
   *
   * event.htmlLink
   *
   * and, when a Meet was created:
   *
   * getGoogleMeetUrl(event)
   */
  return event.data;
}

/**
 * Update an existing Calendar event.
 *
 * Note:
 * This function does not automatically create a Meet.
 * Google Meet creation is intentionally explicit through
 * createEvent({ createGoogleMeet: true }).
 */
export async function updateEvent(
  tenantId: string,
  googleEventId: string,
  updates: Partial<CalendarEventInput>
) {
  const calendar =
    await getCalendarClient(tenantId);

  const requestBody: any = {};

  if (updates.summary !== undefined) {
    requestBody.summary =
      updates.summary;
  }

  if (updates.description !== undefined) {
    requestBody.description =
      updates.description;
  }

  if (updates.startTime !== undefined) {
    requestBody.start = {
      dateTime:
        updates.startTime,
    };
  }

  if (updates.endTime !== undefined) {
    requestBody.end = {
      dateTime:
        updates.endTime,
    };
  }

  if (
    updates.attendeeEmails !==
    undefined
  ) {
    const attendeeEmails =
      updates.attendeeEmails
        .map((email) =>
          email.trim()
        )
        .filter(Boolean);

    requestBody.attendees =
      attendeeEmails.map(
        (email) => ({
          email,
        })
      );
  }

  /**
   * If createGoogleMeet is explicitly true
   * during an update, request a Meet conference.
   *
   * This is useful if an existing Calendar event
   * needs to have Meet added afterward.
   */
  if (
    updates.createGoogleMeet === true
  ) {
    requestBody.conferenceData = {
      createRequest: {
        requestId: `prime-automatic-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 12)}`,

        conferenceSolutionKey: {
          type: "hangoutsMeet",
        },
      },
    };
  }

  const shouldCreateMeet =
    updates.createGoogleMeet === true;

  const event =
    await calendar.events.patch({
      calendarId: "primary",

      eventId: googleEventId,

      sendUpdates: "all",

      conferenceDataVersion:
        shouldCreateMeet
          ? 1
          : 0,

      requestBody,
    });

  console.log(
    "GOOGLE CALENDAR EVENT UPDATED:",
    {
      tenantId,
      googleEventId,
      summary:
        event.data.summary,
      htmlLink:
        event.data.htmlLink,
      googleMeetUrl:
        getGoogleMeetUrl(
          event.data
        ),
    }
  );

  return event.data;
}

/**
 * Delete a Calendar event.
 */
export async function deleteEvent(
  tenantId: string,
  googleEventId: string
) {
  const calendar =
    await getCalendarClient(tenantId);

  await calendar.events.delete({
    calendarId: "primary",

    eventId: googleEventId,

    /**
     * Notify attendees that the event
     * has been cancelled.
     */
    sendUpdates: "all",
  });

  const supabase =
    createServiceSupabase();

  const { error } =
    await supabase
      .from("calendar_events_cache")
      .delete()
      .eq(
        "tenant_id",
        tenantId
      )
      .eq(
        "google_event_id",
        googleEventId
      );

  if (error) {
    console.error(
      "CALENDAR EVENT CACHE DELETE FAILED:",
      {
        tenantId,
        googleEventId,
        error,
      }
    );
  }
}