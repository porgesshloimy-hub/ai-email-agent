import { google } from "googleapis";
import { createServiceSupabase } from "@/lib/supabase/server";
import { decryptToken, encryptToken } from "@/lib/crypto";

async function getAuthedClient(tenantId: string) {
  const supabase = createServiceSupabase();
  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("*")
    .eq("tenant_id", tenantId)
    .single();

  if (!conn) throw new Error(`No Gmail connection for tenant ${tenantId}`);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: decryptToken(conn.access_token_encrypted),
    refresh_token: decryptToken(conn.refresh_token_encrypted),
    expiry_date: new Date(conn.token_expiry).getTime(),
  });

  // Persist refreshed access tokens automatically.
  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await supabase
        .from("gmail_connections")
        .update({
          access_token_encrypted: encryptToken(tokens.access_token),
          token_expiry: new Date(tokens.expiry_date!).toISOString(),
        })
        .eq("tenant_id", tenantId);
    }
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export async function readThread(tenantId: string, threadId: string) {
  const gmail = await getAuthedClient(tenantId);
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
  const gmail = await getAuthedClient(tenantId);
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
  const gmail = await getAuthedClient(tenantId);
  const sent = await gmail.users.drafts.send({
    userId: "me",
    requestBody: { id: draftId },
  });
  return sent.data;
}

export async function archiveThread(tenantId: string, threadId: string) {
  const gmail = await getAuthedClient(tenantId);
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
