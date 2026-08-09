import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";

/**
 * Google Cloud Pub/Sub push endpoint. Configure the Pub/Sub subscription to
 * POST here. This route does the minimum possible work — just enqueues a
 * background job — because Pub/Sub expects a fast 2xx response.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();

  // Pub/Sub wraps the payload; Gmail's message data is base64-encoded JSON
  // containing { emailAddress, historyId }.
  const dataB64 = body?.message?.data;
  if (!dataB64) return NextResponse.json({ ok: true }); // ack anyway, nothing to do

  const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));

  await inngest.send({
    name: "gmail/history.changed",
    data: {
      emailAddress: decoded.emailAddress,
      historyId: decoded.historyId,
    },
  });

  return NextResponse.json({ ok: true });
}
