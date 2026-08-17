import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session on every matched request.
 *
 * This exists because Next.js only allows writing cookies inside
 * middleware, Server Actions, or Route Handlers — never during a
 * Server Component render. Supabase's client tries to refresh an
 * expired access token wherever it's used, including inside Server
 * Components (e.g. the approvals dashboard page). Without this
 * middleware, that refresh has nowhere legal to happen, which is what
 * was crashing the process (see lib/supabase/server.ts for the other
 * half of this fix — the try/catch there is only safe because this
 * middleware is now the thing actually keeping sessions current).
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options });

          response = NextResponse.next({
            request,
          });

          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: "", ...options });

          response = NextResponse.next({
            request,
          });

          response.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  /**
   * This call is what triggers the refresh (if needed) and writes the
   * updated session cookies onto `response` above via the handlers.
   * Discarding the return value is intentional — we only need the
   * side effect of the cookies being set.
   */
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets and image optimization
     * files, which never need an auth session.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};