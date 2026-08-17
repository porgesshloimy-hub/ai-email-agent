import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  getZoomUser,
  createZoomMeeting,
} from "@/lib/zoom/client";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

  const supabase =
    await createServerSupabase();

  const {
    data: { user },
    error: userError,
  } =
    await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json(
      {
        error: "not_authenticated",
      },
      { status: 401 }
    );
  }

  const {
    data: tenant,
    error: tenantError,
  } =
    await supabase
      .from("tenants")
      .select("id")
      .eq(
        "owner_user_id",
        user.id
      )
      .single();

  if (
    tenantError ||
    !tenant
  ) {
    console.error(
      "ZOOM TEST TENANT LOOKUP FAILED:",
      tenantError
    );

    return NextResponse.json(
      {
        error: "tenant_not_found",
      },
      { status: 404 }
    );
  }

  try {
    // First verify the Zoom connection.
    const zoomUser =
      await getZoomUser(
        tenant.id
      );

    console.log(
      "ZOOM TEST USER:",
      {
        tenantId:
          tenant.id,
        zoomUserId:
          zoomUser.id,
        email:
          zoomUser.email,
      }
    );

    // Create a test meeting approximately one hour
    // from now.
    const startTime =
      new Date(
        Date.now() +
          60 * 60 * 1000
      ).toISOString();

    const meeting =
      await createZoomMeeting(
        tenant.id,
        {
          topic:
            "Prime Automatic Test Meeting",

          startTime,

          durationMinutes:
            30,

          timezone:
            "UTC",

          agenda:
            "Test meeting created by Prime Automatic.",
        }
      );

    return NextResponse.json({
      success: true,

      zoomUser: {
        id:
          zoomUser.id,
        email:
          zoomUser.email,
        firstName:
          zoomUser.first_name,
        lastName:
          zoomUser.last_name,
      },

      meeting: {
        id:
          meeting.id,
        topic:
          meeting.topic,
        startTime:
          meeting.start_time,
        duration:
          meeting.duration,
        joinUrl:
          meeting.join_url,
      },
    });
  } catch (error: any) {
    console.error(
      "ZOOM TEST FAILED:",
      {
        tenantId:
          tenant.id,
        errorMessage:
          error?.message,
        error,
      }
    );

    return NextResponse.json(
      {
        error:
          "zoom_test_failed",

        message:
          error?.message ??
          "Unknown error",
      },
      { status: 500 }
    );
  }
}