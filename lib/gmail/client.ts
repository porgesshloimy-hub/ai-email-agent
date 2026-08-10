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
 * Read a Gmail thread.
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
 * Read a single Gmail message.
 */
export async function readMessage(
  tenantId: string,
  messageId: string
) {
  const gmail = await getGmailClient(tenantId);

  const message = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  return message.data;
}

/**
 * Get Gmail history changes after a specific historyId.
 *
 * This is used by the Pub/Sub notification pipeline to discover
 * new messages without repeatedly scanning the entire inbox.
 */
export async function getHistoryChanges(
  tenantId: string,
  startHistoryId: string
) {
  const gmail = await getGmailClient(tenantId);

  const changes: Array<{
    messageId: string;
    threadId: string;
  }> = [];

  let pageToken: string | undefined;

  do {
    const response =
      await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        pageToken,
      });

    for (const history of response.data.history ?? []) {
      for (const messageAdded of history.messagesAdded ?? []) {
        const message = messageAdded.message;

        if (message?.id && message.threadId) {
          changes.push({
            messageId: message.id,
            threadId: message.threadId,
          });
        }
      }
    }

    pageToken =
      response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return {
    historyId:
      (
        await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          maxResults: 1,
        })
      ).data.historyId ?? startHistoryId,
    messages: changes,
  };
}

/**
 * Start/renew Gmail push notifications.
 *
 * Gmail sends notifications to the Google Cloud Pub/Sub
 * topic configured for this project.
 */
export async function watchGmail(
  tenantId: string,
  topicName: string
) {
  const gmail = await getGmailClient(tenantId);

  const response =
    await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName,
        labelIds: ["INBOX"],
        labelFilterAction: "include",
      },
    });

  return response.data;
}

/**
 * Creates a Gmail draft that is properly threaded as a reply
 * to the original message.
 *
 * originalMessageId should be the Gmail message ID of the
 * incoming email whenever possible.
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
 * In-Reply-To and References tell Gmail that this is a
 * reply to the existing conversation.
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

  if (messageIdHeader) {
    headers.push(
      `In-Reply-To: ${messageIdHeader}`
    );
  }

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