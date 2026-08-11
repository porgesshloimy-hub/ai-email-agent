import { NextRequest, NextResponse } from "next/server";
import { verifyGoogleChatRequest } from "@/lib/googlechat/verify";
import { findTenantByGoogleChatSender } from "@/lib/googlechat/matchTenant";
import { handleChatMessage } from "@/lib/agent/chat";

export async function POST(req: NextRequest) {
  const authorized = await verifyGoogleChatRequest(
    req.headers.get("authorization")
  );

  if (!authorized) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  console.log("=== GOOGLE CHAT REQUEST AUTHORIZED ===");

  const event = await req.json();

  console.log("Google Chat event:", {
    type: event.type,
    senderEmail: event.message?.sender?.email,
    text: event.message?.text,
  });

  // Chat sends several event types.
  // Only MESSAGE carries a user message.
  if (event.type !== "MESSAGE") {
    if (event.type === "ADDED_TO_SPACE") {
      return NextResponse.json({
        text: "Hi! I'm your business's AI assistant. Message me here any time — ask what's pending, or ask me to book something on your calendar.",
      });
    }

    return NextResponse.json({});
  }

  const senderEmail: string | undefined =
    event.message?.sender?.email;

  const messageText: string =
    event.message?.text ?? "";

  if (!senderEmail) {
    console.error("Google Chat: No sender email found");

    return NextResponse.json({
      text: "I couldn't verify who's messaging me — please try again.",
    });
  }

  console.log("Google Chat sender:", senderEmail);

  const tenantId =
    await findTenantByGoogleChatSender(senderEmail);

  console.log("Google Chat tenant:", tenantId);

  if (!tenantId) {
    return NextResponse.json({
      text: `I don't recognize this Google account yet. Connect it from your dashboard's Settings page under "Google Chat" first.`,
    });
  }

  try {
    console.log("Sending message to handleChatMessage...");

    const reply =
      await handleChatMessage(tenantId, messageText);

    console.log("handleChatMessage returned:", reply);

    return NextResponse.json({
      text: reply,
    });
  } catch (err) {
    console.error(
      "Error handling Google Chat message:",
      err
    );

    return NextResponse.json({
      text: "Something went wrong on my end — try again in a moment.",
    });
  }
}