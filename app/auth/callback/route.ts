import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(
      new URL("/?error=missing_code", requestUrl.origin)
    );
  }

  const supabase = await createServerSupabase();

  // Exchange Google's OAuth code for a Supabase session.
  const { error: authError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (authError) {
    console.error("Supabase auth callback error:", authError);

    return NextResponse.redirect(
      new URL("/?error=auth_callback_failed", requestUrl.origin)
    );
  }

  // Get the authenticated user.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    console.error("Could not get authenticated user:", userError);

    return NextResponse.redirect(
      new URL("/?error=user_not_found", requestUrl.origin)
    );
  }

  // Check whether this user already has a tenant.
  const { data: existingTenant, error: tenantLookupError } = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_user_id", user.id)
    .maybeSingle();

  if (tenantLookupError) {
    console.error(
      "Tenant lookup failed:",
      tenantLookupError
    );

    return NextResponse.redirect(
      new URL("/?error=tenant_lookup_failed", requestUrl.origin)
    );
  }

  // Create a tenant for brand-new users.
  if (!existingTenant) {
    const googleEmail = user.email ?? null;

    const { error: tenantCreateError } = await supabase
      .from("tenants")
      .insert({
        owner_user_id: user.id,
        business_name:
          user.user_metadata?.full_name ||
          user.user_metadata?.name ||
          googleEmail ||
          "My Business",
        owner_google_email: googleEmail,
      });

    if (tenantCreateError) {
      console.error(
        "Failed to create tenant:",
        tenantCreateError
      );

      return NextResponse.redirect(
        new URL("/?error=tenant_creation_failed", requestUrl.origin)
      );
    }
  }

  return NextResponse.redirect(
    new URL("/dashboard", requestUrl.origin)
  );
}