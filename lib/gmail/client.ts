import { google } from "googleapis";
import { getGoogleAuthedClient } from "@/lib/google/authClient";

async function getGmailClient(tenantId: string) {
  const auth = await getGoogleAuthedClient(tenantId);

  return google.gmail({
    version: "v1",
    auth,
  });
}

/**
 * Read an entire Gmail thread.
 */
export async function readThread(
  tenantId: string,
  threadId: string
) {
  const gmail = await getGmailClient(tenantId);

  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  return thread.data;
}

/**
 * Creates a Gmail draft that is properly threaded as a reply
 * to the original message.
 *
 * Gmail's threadId tells Gmail which conversation the message
 * belongs to, while In-Reply-To and References provide the
 * proper email-level threading information.
 */
export async function createDraft(
  tenantId: string,
  threadId: string,
  to: string,
  subject: string,
  body: string,
  originalMessageId?: string
) {
  const gmail = await getGmailClient(tenantId);

  let messageIdHeader: string | undefined;
  let referencesHeader: string | undefined;

  try {
    if (originalMessageId) {
      // We already know the exact Gmail message ID.
      const originalMessage =
        await gmail.users.messages.get({
          userId: "me",
          id: originalMessageId,
          format: "metadata",
          metadataHeaders: [
            "Message-ID",
            "References",
          ],
        });

      const headers =
        originalMessage.data.payload?.headers ?? [];

      messageIdHeader = getHeaderValue(
        headers,
        "Message-ID"
      );

      referencesHeader = getHeaderValue(
        headers,
        "References"
      );
    } else {
      // Fallback: retrieve the latest message in the thread.
      const thread =
        await gmail.users.threads.get({
          userId: "me",
          id: threadId,
          format: "metadata",
          metadataHeaders: [
            "Message-ID",
            "References",
          ],
        });

      const messages =
        thread.data.messages ?? [];

      if (messages.length > 0) {
        const latestMessage =
          messages[messages.length - 1];

        const headers =
          latestMessage.payload?.headers ?? [];

        messageIdHeader = getHeaderValue(
          headers,
          "Message-ID"
        );

        referencesHeader = getHeaderValue(
          headers,
          "References"
        );
      }
    }
  } catch (error) {
    /**
     * Don't prevent draft creation if retrieving the
     * threading headers fails.
     *
     * Gmail's threadId still gives us conversation-level
     * threading.
     */
    console.warn(
      "Could not retrieve Gmail threading headers:",
      error
    );
  }

  const raw = buildRawMessage({
    to,
    subject,
    body,
    messageIdHeader,
    referencesHeader,
  });

  const draft =
    await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          threadId,
          raw,
        },
      },
    });

  return draft.data;
}

/**
 * Sends an existing Gmail draft.
 *
 * This should only be called by the permission-approved
 * sending path.
 */
export async function sendDraft(
  tenantId: string,
  draftId: string
) {
  const gmail = await getGmailClient(tenantId);

  const sent =
    await gmail.users.drafts.send({
      userId: "me",
      requestBody: {
        id: draftId,
      },
    });

  return sent.data;
}

/**
 * Archive a Gmail thread.
 */
export async function archiveThread(
  tenantId: string,
  threadId: string
) {
  const gmail = await getGmailClient(tenantId);

  return gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: {
      removeLabelIds: ["INBOX"],
    },
  });
}

/**
 * Get a Gmail header value case-insensitively.
 */
function getHeaderValue(
  headers: Array<{
    name?: string | null;
    value?: string | null;
  }>,
  name: string
): string | undefined {
  const header = headers.find(
    (header) =>
      header.name?.toLowerCase() ===
      name.toLowerCase()
  );

  return header?.value ?? undefined;
}

/**
 * Build a properly formatted RFC 2822 email.
 *
 * In-Reply-To and References tell Gmail and other email
 * clients that this message is a reply to the existing
 * conversation.
 */
function buildRawMessage({
  to,
  subject,
  body,
  messageIdHeader,
  referencesHeader,
}: {
  to: string;
  subject: string;
  body: string;
  messageIdHeader?: string;
  referencesHeader?: string;
}) {
  const headers: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
  ];

  /**
   * Reply to the exact original message.
   */
  if (messageIdHeader) {
    headers.push(
      `In-Reply-To: ${messageIdHeader}`
    );
  }

  /**
   * Preserve the existing References chain.
   */
  if (referencesHeader) {
    if (messageIdHeader) {
      headers.push(
        `References: ${referencesHeader} ${messageIdHeader}`
      );
    } else {
      headers.push(
        `References: ${referencesHeader}`
      );
    }
  } else if (messageIdHeader) {
    headers.push(
      `References: ${messageIdHeader}`
    );
  }

  const message = [
    ...headers,
    "",
    body,
  ].join("\r\n");

  return Buffer.from(
    message,
    "utf8"
  ).toString("base64url");
}