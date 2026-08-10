import { google } from "googleapis";
import { getGoogleAuthedClient } from "@/lib/google/authClient";

async function getGmailClient(tenantId: string) {
  const auth = await getGoogleAuthedClient(tenantId);
  return google.gmail({ version: "v1", auth });
}

export async function readThread(tenantId: string, threadId: string) {
  const gmail = await getGmailClient(tenantId);
  const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  return thread.data;
}

/**
 * Creates a Gmail draft. This is the ONLY write path used when an action
 * requires approval — the agent never calls sendMessage() in that case.
 */
export async function createDraft(
  tenantId: string,
  threadId: string,
  to: string,
  subject: string,
  body: string
) {
  const gmail = await getGmailClient(tenantId);
  const raw = buildRawMessage(to, subject, body);

  const draft = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { threadId, raw },
    },
  });
  return draft.data;
}

/**
 * Sends an existing draft. Only ever called from the approval-confirmation
 * path (dashboard "Approve & send" action) or when permission level is
 * "allowed" outright — never directly by the model's tool call.
 */
export async function sendDraft(tenantId: string, draftId: string) {
  const gmail = await getGmailClient(tenantId);
  const sent = await gmail.users.drafts.send({
    userId: "me",
    requestBody: { id: draftId },
  });
  return sent.data;
}

export async function archiveThread(tenantId: string, threadId: string) {
  const gmail = await getGmailClient(tenantId);
  return gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
}

function buildRawMessage(to: string, subject: string, body: string): string {
  const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join(
    "\n"
  );
  return Buffer.from(message).toString("base64url");
}
