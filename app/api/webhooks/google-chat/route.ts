import { NextRequest, NextResponse } from "next/server";
import { verifyGoogleChatRequest } from "@/lib/googlechat/verify";
import { findTenantByGoogleChatSender } from "@/lib/googlechat/matchTenant";
import { handleChatMessage } from "@/lib/agent/chat";

/**
 * Google Chat app HTTP endpoint. Configure this URL in Google Cloud Console
 * → APIs & Services → your project → Chat API → Configuration, as the
 * "App URL" under HTTP endpoint. Google POSTs every message event here and
 * expects a synchronous JSON response containing the reply text.
 */
export async function POST(req: NextRequest) {
  const authorized = await verifyGoogleChatRequest(req.headers.get("authorization"));
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await req.json();

  // Chat sends several event types (ADDED_TO_SPACE, REMOVED_FROM_SPACE,
  // MESSAGE) — only MESSAGE carries a user message to respond to.
  if (event.type !== "MESSAGE") {
    if (event.type === "ADDED_TO_SPACE") {
      return NextResponse.json({
        text: "Hi! I'm your business's AI assistant. Message me here any time — ask what's pending, or ask me to book something on your calendar.",
      });
    }
    return NextResponse.json({});
  }

  const senderEmail: string | undefined = event.message?.sender?.email;
  const messageText: string = event.message?.text ?? "";

  if (!senderEmail) {
    return NextResponse.json({ text: "I couldn't verify who's messaging me — please try again." });
  }

  const tenantId = await findTenantByGoogleChatSender(senderEmail);

  if (!tenantId) {
    return NextResponse.json({
      text: "I don't recognize this Google account yet. Connect it from your dashboard's Settings page under \"Google Chat\" first.",
    });
  }

  try {
    const reply = await handleChatMessage(tenantId, messageText);
    return NextResponse.json({ text: reply });
  } catch (err) {
    console.error("Error handling Google Chat message:", err);
    return NextResponse.json({ text: "Something went wrong on my end — try again in a moment." });
  }
}
