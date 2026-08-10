import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { watchGmail } from "@/lib/gmail/client";

export async function GET(request: Request) {
  const supabase = await createServerSupabase();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=not_authenticated",
        request.url
      )
    );
  }

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user.id)
    .single();

  if (tenantError || !tenant) {
    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=tenant_not_found",
        request.url
      )
    );
  }

  try {
    const watch = await watchGmail(tenant.id);

    console.log("Gmail watch response:", watch);

    if (!watch.historyId || !watch.expiration) {
      console.error(
        "Gmail watch did not return historyId or expiration:",
        watch
      );

      return NextResponse.redirect(
        new URL(
          "/dashboard/settings?error=gmail_watch_failed",
          request.url
        )
      );
    }

    const { error: updateError } = await supabase
      .from("gmail_connections")
      .update({
        history_id: watch.historyId,
        watch_expiry: new Date(
          Number(watch.expiration)
        ).toISOString(),
      })
      .eq("tenant_id", tenant.id);

    if (updateError) {
      console.error(
        "Failed to save Gmail watch information:",
        updateError
      );

      return NextResponse.redirect(
        new URL(
          "/dashboard/settings?error=gmail_watch_save_failed",
          request.url
        )
      );
    }

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?gmail_watch_enabled=true",
        request.url
      )
    );
  } catch (error) {
    console.error("Gmail watch registration failed:", error);

    return NextResponse.redirect(
      new URL(
        "/dashboard/settings?error=gmail_watch_failed",
        request.url
      )
    );
  }
}