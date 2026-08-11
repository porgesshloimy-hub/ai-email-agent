import { NextRequest, NextResponse } from "next/server";
import { verifyGoogleChatRequest } from "@/lib/googlechat/verify";
import { findTenantByGoogleChatSender } from "@/lib/googlechat/matchTenant";
import { handleChatMessage } from "@/lib/agent/chat";

export async function POST(req: NextRequest) {
  console.error("===== GOOGLE CHAT ROUTE START =====");

  const authHeader = req.headers.get("authorization");

  console.error("Google Chat authorization header present:", !!authHeader);

  const authorized = await verifyGoogleChatRequest(authHeader);

  console.error("Google Chat authorized:", authorized);

  if (!authorized) {
    console.error("===== GOOGLE CHAT ROUTE: UNAUTHORIZED =====");

    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  console.error("===== GOOGLE CHAT ROUTE: AUTHORIZED =====");

  const event = await req.json();

  console.error("===== GOOGLE CHAT EVENT =====");
  console.error({
    type: event.type,
    senderEmail: event.message?.sender?.email,
    text: event.message?.text,
  });

  // Google Chat sends several event types.
  if (event.type !== "MESSAGE") {
    console.error(
      "Google Chat non-MESSAGE event:",
      event.type
    );

    if (event.type === "ADDED_TO_SPACE") {
      console.error("Google Chat app was added to a space");

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

  console.error("Google Chat MESSAGE received");
  console.error("Google Chat sender:", senderEmail);
  console.error("Google Chat message:", messageText);

  if (!senderEmail) {
    console.error("Google Chat: NO SENDER EMAIL");

    return NextResponse.json({
      text: "I couldn't verify who's messaging me — please try again.",
    });
  }

  const tenantId =
    await findTenantByGoogleChatSender(senderEmail);

  console.error("Google Chat tenant lookup result:", tenantId);

  if (!tenantId) {
    console.error(
      "Google Chat: No tenant found for:",
      senderEmail
    );

    return NextResponse.json({
      text: `I don't recognize this Google account yet. Connect it from your dashboard's Settings page under "Google Chat" first.`,
    });
  }

  try {
    console.error(
      "Google Chat: Calling handleChatMessage..."
    );

    const reply =
      await handleChatMessage(tenantId, messageText);

    console.error(
      "Google Chat: handleChatMessage completed"
    );

    console.error(
      "Google Chat reply:",
      reply
    );

    return NextResponse.json({
      text: reply,
    });
  } catch (err) {
    console.error(
      "===== GOOGLE CHAT HANDLE MESSAGE ERROR ====="
    );
    console.error(err);

    return NextResponse.json({
      text: "Something went wrong on my end — try again in a moment.",
    });
  }
}