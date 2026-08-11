import { google } from "googleapis";
import { getGoogleAuthedClient } from "@/lib/google/authClient";

async function getGmailClient(tenantId: string) {
  const auth = await getGoogleAuthedClient(tenantId);

  const gmail = google.gmail({
    version: "v1",
    auth,
  });

  // Diagnostic: confirm which Google account the OAuth token belongs to.
  const profile = await gmail.users.getProfile({
    userId: "me",
  });

  console.log("GMAIL AUTHENTICATED AS:", profile.data.emailAddress);

  return gmail;
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
 * Read a single Gmail message.
 */
export async function readMessage(
  tenantId: string,
  messageId: string
) {
  const gmail = await getGmailClient(tenantId);

  console.log("GMAIL READ MESSAGE:", {
    tenantId,
    messageId,
  });

  try {
    const message = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    console.log("GMAIL READ MESSAGE SUCCESS:", {
      tenantId,
      messageId,
      threadId: message.data.threadId,
    });

    return message.data;
  } catch (error: any) {
    console.error("GMAIL READ MESSAGE FAILED:", {
      tenantId,
      messageId,
      errorCode: error?.code,
      errorMessage: error?.message,
      status: error?.response?.status,
      statusText: error?.response?.statusText,
      responseData: error?.response?.data,
    });

    throw error;
  }
}

/**
 * Get new Gmail messages since a previous historyId.
 *
 * Gmail's History API only tells us which message IDs changed.
 * We then retrieve each complete message and extract:
 *
 * - messageId
 * - threadId
 * - from
 * - subject
 * - bodyText
 */
export async function getHistoryChanges(
  tenantId: string,
  startHistoryId: string
) {
  const gmail = await getGmailClient(tenantId);

  const messages: Array<{
    messageId: string;
    threadId: string;
    from: string;
    subject: string;
    bodyText: string;
  }> = [];

  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;

  do {
    console.log("GMAIL HISTORY REQUEST:", {
      tenantId,
      startHistoryId,
      pageToken,
    });

    const response = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
      pageToken,
    });

    console.log("GMAIL HISTORY RESULT:", {
      tenantId,
      startHistoryId,
      returnedHistoryId: response.data.historyId,
      historyCount: response.data.history?.length ?? 0,
      nextPageToken: response.data.nextPageToken,
    });

    if (response.data.historyId) {
      latestHistoryId = response.data.historyId;
    }

    for (const history of response.data.history ?? []) {
      for (const messageAdded of history.messagesAdded ?? []) {
        const messageId = messageAdded.message?.id;
        const threadId = messageAdded.message?.threadId;

        console.log("GMAIL HISTORY MESSAGE FOUND:", {
          tenantId,
          messageId,
          threadId,
        });

        if (!messageId || !threadId) {
          console.log(
            "GMAIL HISTORY MESSAGE SKIPPED: missing messageId or threadId",
            {
              tenantId,
              messageId,
              threadId,
            }
          );

          continue;
        }

        console.log("GMAIL FETCHING NEW MESSAGE:", {
          tenantId,
          messageId,
          threadId,
        });

        let message;

        try {
          message = await readMessage(
            tenantId,
            messageId
          );
        } catch (error: any) {
          if (error?.code === 404) {
            console.warn(
              "GMAIL MESSAGE NO LONGER EXISTS:",
              {
                tenantId,
                messageId,
                threadId,
              }
            );

            continue;
          }

          console.error(
            "GMAIL FAILED TO READ MESSAGE:",
            {
              tenantId,
              messageId,
              threadId,
              error,
            }
          );

          throw error;
        }

        const headers =
          message.payload?.headers ?? [];

        const from =
          getHeaderValue(headers, "From") ?? "";

        const subject =
          getHeaderValue(headers, "Subject") ?? "";

        const bodyText =
          extractPlainTextBody(
            message.payload
          ) ?? "";

        console.log("GMAIL MESSAGE EXTRACTED:", {
          tenantId,
          messageId,
          threadId,
          from,
          subject,
          bodyLength: bodyText.length,
        });

        messages.push({
          messageId,
          threadId,
          from,
          subject,
          bodyText,
        });
      }
    }

    pageToken =
      response.data.nextPageToken ??
      undefined;
  } while (pageToken);

  console.log("GMAIL HISTORY COMPLETE:", {
    tenantId,
    startHistoryId,
    latestHistoryId,
    messagesFound: messages.length,
  });

  return {
    historyId: latestHistoryId,
    messages,
  };
}

/**
 * Start or renew Gmail push notifications.
 *
 * GOOGLE_PUBSUB_TOPIC should contain the full Pub/Sub topic name,
 * for example:
 *
 * projects/ai-email-agent-505111/topics/gmail-push
 */
export async function watchGmail(
  tenantId: string
) {
  const gmail = await getGmailClient(tenantId);

  const topicName =
    process.env.GOOGLE_PUBSUB_TOPIC;

  if (!topicName) {
    throw new Error(
      "GOOGLE_PUBSUB_TOPIC environment variable is not set"
    );
  }

  console.log("GMAIL WATCH REQUEST:", {
    tenantId,
    topicName,
  });

  const response =
    await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName,
        labelIds: ["INBOX"],
        labelFilterAction: "include",
      },
    });

  console.log("GMAIL WATCH CREATED:", {
    tenantId,
    historyId: response.data.historyId,
    expiration: response.data.expiration,
  });

  return response.data;
}

/**
 * Creates a Gmail draft that is properly threaded as a reply
 * to the original message.
 *
 * originalMessageId is optional because some older callers may
 * not provide it. When supplied, it is used to retrieve the
 * exact original message's Message-ID and References headers.
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
        originalMessage.data.payload?.headers ??
        [];

      messageIdHeader =
        getHeaderValue(
          headers,
          "Message-ID"
        );

      referencesHeader =
        getHeaderValue(
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

      const threadMessages =
        thread.data.messages ?? [];

      if (threadMessages.length > 0) {
        const latestMessage =
          threadMessages[
            threadMessages.length - 1
          ];

        const headers =
          latestMessage.payload?.headers ??
          [];

        messageIdHeader =
          getHeaderValue(
            headers,
            "Message-ID"
          );

        referencesHeader =
          getHeaderValue(
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
     * Gmail's threadId still provides conversation-level
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
 * Send an existing Gmail draft.
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
 * Extract readable text from a Gmail message payload.
 *
 * Handles:
 *
 * - text/plain
 * - multipart messages
 * - text/html as a fallback
 */
function extractPlainTextBody(
  payload: any
): string {
  if (!payload) {
    return "";
  }

  if (
    payload.mimeType === "text/plain" &&
    payload.body?.data
  ) {
    return Buffer.from(
      payload.body.data,
      "base64url"
    ).toString("utf8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const text =
        extractPlainTextBody(part);

      if (text) {
        return text;
      }
    }
  }

  if (
    payload.mimeType === "text/html" &&
    payload.body?.data
  ) {
    const html = Buffer.from(
      payload.body.data,
      "base64url"
    ).toString("utf8");

    return htmlToText(html);
  }

  return "";
}

/**
 * Basic HTML → text conversion.
 */
function htmlToText(
  html: string
): string {
  return html
    .replace(
      /<style[^>]*>[\s\S]*?<\/style>/gi,
      ""
    )
    .replace(
      /<script[^>]*>[\s\S]*?<\/script>/gi,
      ""
    )
    .replace(
      /<br\s*\/?>/gi,
      "\n"
    )
    .replace(
      /<\/p>/gi,
      "\n"
    )
    .replace(
      /<[^>]+>/g,
      ""
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&lt;/gi,
      "<"
    )
    .replace(
      /&gt;/gi,
      ">"
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

/**
 * Build an RFC 2822 email.
 *
 * In-Reply-To and References ensure the reply is associated
 * with the original email conversation.
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