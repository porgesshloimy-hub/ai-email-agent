import { NextResponse } from "next/server";

export async function GET() {
  const clientId = process.env.ZOOM_CLIENT_ID;

  if (!clientId) {
    return new NextResponse("ZOOM_CLIENT_ID is not configured", {
      status: 500,
    });
  }

  const redirectUri =
    "https://www.primeautomatic.com/api/auth/zoom/callback";

  const zoomAuthUrl = new URL("https://zoom.us/oauth/authorize");

  zoomAuthUrl.searchParams.set("response_type", "code");
  zoomAuthUrl.searchParams.set("client_id", clientId);
  zoomAuthUrl.searchParams.set("redirect_uri", redirectUri);

  return NextResponse.redirect(zoomAuthUrl.toString());
}