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

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("Supabase auth callback error:", error);

    return NextResponse.redirect(
      new URL("/?error=auth_callback_failed", requestUrl.origin)
    );
  }

  return NextResponse.redirect(
    new URL("/dashboard", requestUrl.origin)
  );
}