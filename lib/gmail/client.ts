import { google } from "googleapis";
import {
  getGoogleAuthedClient,
  markGoogleReauthRequired,
} from "@/lib/google/authClient";

/**
 * Detect Google's "the refresh token is dead" error. This can arrive in
 * a few slightly different shapes depending on which layer surfaces it
 * (a raw OAuth token-endpoint response vs. an error the googleapis
 * client wraps) — checked defensively across all of them.
 */
function isInvalidGrantError(error: any): boolean {
  return (
    error?.message === "invalid_grant" ||
    error?.response?.data?.error === "invalid_grant" ||
    error?.response?.data?.error_description
      ?.toLowerCase()
      ?.includes("expired or revoked")
  );
}

/**
 * Every exported function in this file calls getGmailClient() first, and
 * the diagnostic getProfile() call below is the very first live API call
 * made on any freshly-authed client — so it's the single earliest point
 * an expired/revoked Google grant (invalid_grant) will surface, for
 * every single caller (readThread, readMessage, getHistoryChanges,
 * watchGmail, createDraft, sendDraft, deleteDraft, archiveThread,
 * getDraftResolution).
 *
 * BUG FIX: this used to log-and-rethrow the raw error with no
 * invalid_grant detection at all — markGoogleReauthRequired() only ever
 * got called from readThread's own catch block further down, which
 * wraps a *later* API call (thread.get()), not this one. Since
 * invalid_grant almost always fires right here, on the very first call,
 * readThread's handling essentially never triggered in practice, and
 * every other caller (most importantly getHistoryChanges, which is what
 * the Gmail-push Inngest handler calls on every single notification) had
 * no handling at all. The result: an already-dead refresh token got
 * retried against Google's token endpoint on every Gmail push
 * notification, forever, each attempt logging the full raw gaxios error
 * (a large stack trace) and never marking the connection for reconnect —
 * hence a continuously growing wall of identical errors with no
 * corresponding "Needs reconnect" prompt ever appearing anywhere.
 *
 * Fixed by handling it once, here, where it actually occurs.
 */
async function getGmailClient(tenantId: string) {
  const auth = await getGoogleAuthedClient(tenantId);

  const gmail = google.gmail({
    version: "v1",
    auth,
  });

  // Diagnostic: confirm which Google account the OAuth token belongs to.
  try {
    const profile = await gmail.users.getProfile({
      userId: "me",
    });

    console.log("GMAIL AUTHENTICATED AS:", {
      tenantId,
      emailAddress: profile.data.emailAddress,
      messagesTotal: profile.data.messagesTotal,
      threadsTotal: profile.data.threadsTotal,
      historyId: profile.data.historyId,
    });
  } catch (error: any) {
    if (isInvalidGrantError(error)) {
      await markGoogleReauthRequired(tenantId);

      console.warn("GOOGLE OAUTH GRANT INVALID — REAUTH REQUIRED:", {
        tenantId,
      });

      throw new Error("GOOGLE_REAUTH_REQUIRED");
    }

    console.error("GMAIL PROFILE CHECK FAILED:", {
      tenantId,
      errorCode: error?.code,
      errorMessage: error?.message,
      status: error?.response?.status,
    });

    throw error;
  }

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

  console.log("GMAIL READ THREAD:", {
    tenantId,
    threadId,
  });

  try {
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    console.log("GMAIL READ THREAD SUCCESS:", {
      tenantId,
      threadId,
      messageCount: thread.data.messages?.length ?? 0,
    });

    return thread.data;
  } catch (error: any) {
  /**
   * getGmailClient() above already handles the common case (grant
   * already dead before this function even started). This remains as a
   * narrower defense: the grant going invalid in the gap between that
   * check succeeding and this specific call running.
   */
  if (isInvalidGrantError(error)) {
    await markGoogleReauthRequired(tenantId);

    console.warn(
      "GOOGLE OAUTH GRANT INVALID — REAUTH REQUIRED:",
      {
        tenantId,
      }
    );

    throw new Error("GOOGLE_REAUTH_REQUIRED");
  }

  console.error("GMAIL READ THREAD FAILED:", {
    tenantId,
    threadId,
    errorCode: error?.code,
    errorMessage: error?.message,
    status: error?.response?.status,
    responseData: error?.response?.data,
  });

  throw error;
}
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
      labelIds: message.data.labelIds,
      internalDate: message.data.internalDate,
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
 * NEW: lists recent inbox messages with real metadata (sender, subject,
 * date, snippet, unread status) — not tied to any specific known
 * message/thread id the way readThread()/readMessage() are.
 *
 * Found missing entirely while wiring up owner-chat email access: the
 * only Gmail functions that existed all required already knowing a
 * specific thread/message id (readThread, readMessage) or were push-
 * event-driven (getHistoryChanges) — there was no general "what's
 * recently in the inbox" lookup a chat conversation could call on
 * demand. Gated by lib/agent/permissions.ts's canReadGmail(), a real
 * connection-checked resolver that also didn't exist before this.
 */
export async function searchRecentMessages(
  tenantId: string,
  maxResults = 10,
  query = "in:inbox"
) {
  const gmail = await getGmailClient(tenantId);

  console.log("GMAIL SEARCH RECENT MESSAGES:", {
    tenantId,
    maxResults,
    query,
  });

  try {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: query,
    });

    const messageRefs = listRes.data.messages ?? [];

    const messages = await Promise.all(
      messageRefs.map(async (ref) => {
        if (!ref.id) return null;

        const full = await gmail.users.messages.get({
          userId: "me",
          id: ref.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers = full.data.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find(
            (h) => h.name?.toLowerCase() === name.toLowerCase()
          )?.value ?? null;

        return {
          id: ref.id,
          threadId: full.data.threadId ?? null,
          from: getHeader("From"),
          subject: getHeader("Subject"),
          date: getHeader("Date"),
          snippet: full.data.snippet ?? null,
          isUnread: full.data.labelIds?.includes("UNREAD") ?? false,
        };
      })
    );

    const results = messages.filter(
      (m): m is NonNullable<typeof m> => m !== null
    );

    console.log("GMAIL SEARCH RECENT MESSAGES SUCCESS:", {
      tenantId,
      resultCount: results.length,
    });

    return results;
  } catch (error: any) {
    console.error("GMAIL SEARCH RECENT MESSAGES FAILED:", {
      tenantId,
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
 * Gmail's History API tells us which messages changed.
 *
 * IMPORTANT:
 * A message returned by history.list() may no longer exist by the
 * time we try to retrieve it. This is normal Gmail behavior.
 *
 * We therefore:
 * - Ignore deleted/stale message IDs
 * - Ignore sent messages
 * - Ignore drafts
 * - Ignore automated emails
 * - Ignore Promotions
 * - Ignore Updates
 * - Ignore mailing lists
 * - Ignore no-reply addresses
 *
 * This function should return only genuine incoming customer-style
 * messages for the agent to process.
 *
 * ALSO returns draftEvents: real-time signals that a draft the app is
 * tracking was sent or deleted directly in Gmail (outside the app's
 * approve/reject buttons), detected from the same history diff via
 * the broadened watch scope (INBOX + SENT + DRAFT). This lets the
 * webhook path resolve those rows immediately instead of waiting on
 * the reconcilePendingDrafts cron, which remains as a safety net for
 * anything this path misses.
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

  const draftEvents: Array<{
    messageId: string;
    event: "sent" | "deleted";
  }> = [];

  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;

  let historyRecordsSeen = 0;
  let messageIdsSeen = 0;
  let messagesReadSuccessfully = 0;
  let staleMessages = 0;
  let ignoredMessages = 0;
  let acceptedMessages = 0;

  console.log("GMAIL HISTORY START:", {
    tenantId,
    startHistoryId,
  });

  do {
    console.log("GMAIL HISTORY REQUEST:", {
      tenantId,
      startHistoryId,
      pageToken,
    });

    let response;

    try {
      response = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded", "messageDeleted", "labelAdded"],
        pageToken,
      });
    } catch (error: any) {
      console.error("GMAIL HISTORY REQUEST FAILED:", {
        tenantId,
        startHistoryId,
        pageToken,
        errorCode: error?.code,
        errorMessage: error?.message,
        status: error?.response?.status,
        responseData: error?.response?.data,
      });

      throw error;
    }

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
      historyRecordsSeen++;

      for (const messageAdded of history.messagesAdded ?? []) {
        messageIdsSeen++;

        const messageId = messageAdded.message?.id;
        const threadId = messageAdded.message?.threadId;

        if (!messageId || !threadId) {
          console.warn(
            "GMAIL HISTORY MESSAGE SKIPPED: MISSING IDS",
            {
              tenantId,
              messageId,
              threadId,
            }
          );

          continue;
        }

        console.log("GMAIL HISTORY MESSAGE FOUND:", {
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

          messagesReadSuccessfully++;
        } catch (error: any) {
          /**
           * Gmail can report a message in history that has already
           * been deleted, moved, or otherwise become unavailable.
           *
           * A 404 here is NOT an application failure.
           *
           * Skip it and continue processing the remaining history.
           */
          if (error?.code === 404) {
            staleMessages++;

            console.warn(
              "GMAIL MESSAGE STALE OR DELETED — SKIPPING:",
              {
                tenantId,
                messageId,
                threadId,
                startHistoryId,
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
              errorCode: error?.code,
              errorMessage: error?.message,
              status: error?.response?.status,
            }
          );

          throw error;
        }

        const headers =
          message.payload?.headers ?? [];

        const from =
          getHeaderValue(
            headers,
            "From"
          ) ?? "";

        const to =
          getHeaderValue(
            headers,
            "To"
          ) ?? "";

        const cc =
          getHeaderValue(
            headers,
            "Cc"
          ) ?? "";

        const subject =
          getHeaderValue(
            headers,
            "Subject"
          ) ?? "";

        const messageIdHeader =
          getHeaderValue(
            headers,
            "Message-ID"
          );

        const inReplyTo =
          getHeaderValue(
            headers,
            "In-Reply-To"
          );

        const autoSubmitted =
          getHeaderValue(
            headers,
            "Auto-Submitted"
          );

        const precedence =
          getHeaderValue(
            headers,
            "Precedence"
          )?.toLowerCase();

        const listUnsubscribe =
          getHeaderValue(
            headers,
            "List-Unsubscribe"
          );

        const deliveredTo =
          getHeaderValue(
            headers,
            "Delivered-To"
          );

        const fromLower =
          from.toLowerCase();

        const labelIds =
          message.labelIds ?? [];

        /**
         * --------------------------------------------------------
         * IMPORTANT: SENT / DRAFT PROTECTION
         * --------------------------------------------------------
         *
         * We only want incoming customer emails.
         *
         * Gmail labels messages sent by the authenticated user
         * with SENT.
         *
         * Draft messages have the DRAFT label.
         *
         * This prevents the agent from seeing its own outgoing
         * messages/drafts as customer messages.
         */
        const isSent =
          labelIds.includes("SENT");

        const isDraft =
          labelIds.includes("DRAFT");

        if (isSent || isDraft) {
          ignoredMessages++;

          console.log(
            "GMAIL MESSAGE IGNORED: SELF-GENERATED / DRAFT",
            {
              tenantId,
              messageId,
              threadId,
              from,
              to,
              subject,
              labelIds,
              reason: isDraft
                ? "draft"
                : "sent",
            }
          );

          continue;
        }

        /**
         * --------------------------------------------------------
         * AUTOMATED EMAIL DETECTION
         * --------------------------------------------------------
         */

        const isNoReply =
          /(^|[\s<])(no-?reply|noreply|donotreply|do-not-reply)([@\s>]|$)/i.test(
            fromLower
          );

        const isBulk =
          precedence === "bulk";

        const isList =
          precedence === "list";

        const isAutomated =
          Boolean(autoSubmitted) ||
          isBulk ||
          isList ||
          Boolean(listUnsubscribe) ||
          isNoReply;

        /**
         * --------------------------------------------------------
         * GMAIL CATEGORY FILTER
         * --------------------------------------------------------
         */

        const isPromotions =
          labelIds.includes(
            "CATEGORY_PROMOTIONS"
          );

        const isUpdates =
          labelIds.includes(
            "CATEGORY_UPDATES"
          );

        if (
          isAutomated ||
          isPromotions ||
          isUpdates
        ) {
          ignoredMessages++;

          let reason = "automated";

          if (isPromotions) {
            reason = "promotions";
          } else if (isUpdates) {
            reason = "updates";
          } else if (isNoReply) {
            reason = "no-reply";
          } else if (autoSubmitted) {
            reason = "auto-submitted";
          } else if (isBulk) {
            reason = "bulk";
          } else if (isList) {
            reason = "mailing-list";
          } else if (listUnsubscribe) {
            reason = "list-unsubscribe";
          }

          console.log(
            "GMAIL MESSAGE IGNORED: AUTOMATED",
            {
              tenantId,
              messageId,
              threadId,
              from,
              to,
              subject,
              reason,
              autoSubmitted,
              precedence,
              hasListUnsubscribe:
                Boolean(listUnsubscribe),
              labelIds,
            }
          );

          continue;
        }

        /**
         * --------------------------------------------------------
         * BODY EXTRACTION
         * --------------------------------------------------------
         */

        const bodyText =
          extractPlainTextBody(
            message.payload
          ) ?? "";

        /**
         * --------------------------------------------------------
         * FINAL ACCEPTANCE
         * --------------------------------------------------------
         */

        acceptedMessages++;

        console.log(
          "GMAIL MESSAGE ACCEPTED FOR AGENT:",
          {
            tenantId,
            messageId,
            threadId,
            from,
            to,
            cc,
            subject,
            deliveredTo,
            messageIdHeader,
            inReplyTo,
            labelIds,
            bodyLength: bodyText.length,
          }
        );

        messages.push({
          messageId,
          threadId,
          from,
          subject,
          bodyText,
        });
      }

      /**
       * A message was permanently deleted. If it's a Gmail draft's
       * underlying message that email_actions is tracking, this
       * means the owner deleted the draft directly in Gmail.
       */
      for (const messageDeleted of history.messagesDeleted ?? []) {
        const messageId = messageDeleted.message?.id;

        if (!messageId) continue;

        console.log("GMAIL HISTORY MESSAGE DELETED:", {
          tenantId,
          messageId,
        });

        draftEvents.push({ messageId, event: "deleted" });
      }

      /**
       * A message gained a label. If that label is SENT, and the
       * message is a Gmail draft's underlying message that
       * email_actions is tracking, this means the owner sent the
       * draft directly in Gmail.
       */
      for (const labelAdded of history.labelsAdded ?? []) {
        const messageId = labelAdded.message?.id;
        const labelIds = labelAdded.labelIds ?? [];

        if (!messageId) continue;

        if (labelIds.includes("SENT")) {
          console.log("GMAIL HISTORY MESSAGE SENT (LABEL ADDED):", {
            tenantId,
            messageId,
          });

          draftEvents.push({ messageId, event: "sent" });
        }
      }
    }

    pageToken =
      response.data.nextPageToken ??
      undefined;
  } while (pageToken);

  console.log(
    "GMAIL HISTORY COMPLETE:",
    {
      tenantId,
      startHistoryId,
      latestHistoryId,

      historyRecordsSeen,
      messageIdsSeen,
      messagesReadSuccessfully,

      staleMessages,
      ignoredMessages,
      acceptedMessages,

      messagesFound:
        messages.length,

      draftEventsFound:
        draftEvents.length,

      messageIds:
        messages.map(
          (message) => message.messageId
        ),
    }
  );

  return {
    historyId: latestHistoryId,
    messages,
    draftEvents,
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
  const gmail =
    await getGmailClient(
      tenantId
    );

  const topicName =
    process.env.GOOGLE_PUBSUB_TOPIC;

  if (!topicName) {
    throw new Error(
      "GOOGLE_PUBSUB_TOPIC environment variable is not set"
    );
  }

  console.log(
    "GMAIL WATCH REQUEST:",
    {
      tenantId,
      topicName,
    }
  );

  try {
    const response =
      await gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName,
          // Broadened from ["INBOX"] so push notifications also fire
          // when the owner sends or deletes a draft directly in
          // Gmail (SENT/DRAFT label changes), not just new inbox
          // mail. Existing tenants keep their old watch scope until
          // it's next renewed (see renewGmailWatches) — this only
          // applies to new/renewed watches going forward.
          labelIds: ["INBOX", "SENT", "DRAFT"],
          labelFilterAction:
            "include",
        },
      });

    console.log(
      "GMAIL WATCH CREATED:",
      {
        tenantId,
        historyId:
          response.data.historyId,
        expiration:
          response.data.expiration,
      }
    );

    return response.data;
  } catch (error: any) {
    console.error(
      "GMAIL WATCH FAILED:",
      {
        tenantId,
        topicName,
        errorCode: error?.code,
        errorMessage: error?.message,
        status: error?.response?.status,
        responseData:
          error?.response?.data,
      }
    );

    throw error;
  }
}

/**
 * Creates a Gmail draft that is properly threaded as a reply
 * to the original message.
 *
 * originalMessageId is optional because some older callers may
 * not provide it.
 */
export async function createDraft(
  tenantId: string,
  threadId: string,
  to: string,
  subject: string,
  body: string,
  originalMessageId?: string
) {
  const gmail =
    await getGmailClient(
      tenantId
    );

  console.log(
    "GMAIL CREATE DRAFT:",
    {
      tenantId,
      threadId,
      to,
      subject,
      originalMessageId,
      bodyLength: body.length,
    }
  );

  let messageIdHeader:
    | string
    | undefined;

  let referencesHeader:
    | string
    | undefined;

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
        originalMessage.data.payload
          ?.headers ?? [];

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
          latestMessage.payload
            ?.headers ?? [];

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
  } catch (error: any) {
    /**
     * If the original message disappeared between the time
     * the agent read it and the time the draft was created,
     * we can still attempt to create the draft using the
     * Gmail threadId.
     */
    console.warn(
      "GMAIL THREADING HEADERS UNAVAILABLE:",
      {
        tenantId,
        threadId,
        originalMessageId,
        errorCode: error?.code,
        errorMessage: error?.message,
        status: error?.response?.status,
      }
    );
  }

  const raw =
    buildRawMessage({
      to,
      subject,
      body,
      messageIdHeader,
      referencesHeader,
    });

  try {
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

    console.log(
      "GMAIL DRAFT CREATED:",
      {
        tenantId,
        threadId,
        draftId:
          draft.data.id,
        messageId:
          draft.data.message?.id,
      }
    );

    return draft.data;
  } catch (error: any) {
    console.error(
      "GMAIL CREATE DRAFT FAILED:",
      {
        tenantId,
        threadId,
        to,
        subject,
        originalMessageId,
        errorCode: error?.code,
        errorMessage: error?.message,
        status: error?.response?.status,
        responseData:
          error?.response?.data,
      }
    );

    throw error;
  }
}

/**
 * Send an existing Gmail draft.
 */
export async function sendDraft(
  tenantId: string,
  draftId: string
) {
  const gmail =
    await getGmailClient(
      tenantId
    );

  console.log(
    "GMAIL SEND DRAFT:",
    {
      tenantId,
      draftId,
    }
  );

  try {
    const sent =
      await gmail.users.drafts.send({
        userId: "me",
        requestBody: {
          id: draftId,
        },
      });

    console.log(
      "GMAIL DRAFT SENT:",
      {
        tenantId,
        draftId,
        messageId:
          sent.data.id,
        threadId:
          sent.data.threadId,
      }
    );

    return sent.data;
  } catch (error: any) {
    console.error(
      "GMAIL SEND DRAFT FAILED:",
      {
        tenantId,
        draftId,
        errorCode: error?.code,
        errorMessage: error?.message,
        status: error?.response?.status,
        responseData:
          error?.response?.data,
      }
    );

    throw error;
  }
}

/**
 * Delete an existing Gmail draft.
 */
export async function deleteDraft(
  tenantId: string,
  draftId: string
) {
  const gmail = await getGmailClient(tenantId);
 
  console.log("GMAIL DELETE DRAFT:", {
    tenantId,
    draftId,
  });
 
  try {
    await gmail.users.drafts.delete({
      userId: "me",
      id: draftId,
    });
 
    console.log("GMAIL DRAFT DELETED:", {
      tenantId,
      draftId,
    });
  } catch (error: any) {
    /**
     * If the draft is already gone (e.g. the owner already sent or
     * deleted it manually in Gmail, and our reconciliation job hasn't
     * caught up yet), a 404 here isn't a real failure — the end state
     * we wanted (no draft sitting in Gmail) is already true.
     */
    if (error?.code === 404) {
      console.warn("GMAIL DELETE DRAFT: ALREADY GONE", {
        tenantId,
        draftId,
      });
 
      return;
    }
 
    console.error("GMAIL DELETE DRAFT FAILED:", {
      tenantId,
      draftId,
      errorCode: error?.code,
      errorMessage: error?.message,
      status: error?.response?.status,
      responseData: error?.response?.data,
    });
 
    throw error;
  }
}

/**
 * Archive a Gmail thread.
 */
export async function archiveThread(
  tenantId: string,
  threadId: string
) {
  const gmail =
    await getGmailClient(
      tenantId
    );

  console.log(
    "GMAIL ARCHIVE THREAD:",
    {
      tenantId,
      threadId,
    }
  );

  try {
    const result =
      await gmail.users.threads.modify({
        userId: "me",
        id: threadId,
        requestBody: {
          removeLabelIds: [
            "INBOX",
          ],
        },
      });

    console.log(
      "GMAIL THREAD ARCHIVED:",
      {
        tenantId,
        threadId,
      }
    );

    return result;
  } catch (error: any) {
    console.error(
      "GMAIL ARCHIVE THREAD FAILED:",
      {
        tenantId,
        threadId,
        errorCode: error?.code,
        errorMessage: error?.message,
        status: error?.response?.status,
        responseData:
          error?.response?.data,
      }
    );

    throw error;
  }
}

//Monitor draft for deleted and sent emails
export async function getDraftResolution(
  tenantId: string,
  draftId: string,
  messageId: string | null
): Promise<"still_draft" | "sent" | "deleted" | "unknown"> {
  const gmail = await getGmailClient(tenantId);
 
  try {
    await gmail.users.drafts.get({
      userId: "me",
      id: draftId,
    });
 
    // Draft still exists — nothing to reconcile.
    return "still_draft";
  } catch (error: any) {
    if (error?.code !== 404) {
      console.error("GMAIL DRAFT STATUS CHECK FAILED:", {
        tenantId,
        draftId,
        errorCode: error?.code,
        errorMessage: error?.message,
        status: error?.response?.status,
      });
 
      return "unknown";
    }
 
    console.log("GMAIL DRAFT NO LONGER EXISTS:", {
      tenantId,
      draftId,
      messageId,
    });
  }
 
  // Draft is gone. If we don't have the underlying message ID (older
  // rows created before this column existed), we can't tell sent from
  // deleted — treat as unknown so the row isn't guessed at incorrectly.
  if (!messageId) {
    console.warn("GMAIL DRAFT GONE BUT NO MESSAGE ID STORED:", {
      tenantId,
      draftId,
    });
 
    return "unknown";
  }
 
  try {
    const message = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "minimal",
    });
 
    const labelIds = message.data.labelIds ?? [];
    const wasSent = labelIds.includes("SENT");
 
    console.log("GMAIL DRAFT RESOLUTION MESSAGE CHECK:", {
      tenantId,
      draftId,
      messageId,
      labelIds,
      wasSent,
    });
 
    return wasSent ? "sent" : "unknown";
  } catch (error: any) {
    if (error?.code === 404) {
      console.log("GMAIL DRAFT RESOLUTION: MESSAGE ALSO GONE — DELETED:", {
        tenantId,
        draftId,
        messageId,
      });
 
      return "deleted";
    }
 
    console.error("GMAIL DRAFT RESOLUTION MESSAGE CHECK FAILED:", {
      tenantId,
      draftId,
      messageId,
      errorCode: error?.code,
      errorMessage: error?.message,
      status: error?.response?.status,
    });
 
    return "unknown";
  }
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
  const header =
    headers.find(
      (header) =>
        header.name?.toLowerCase() ===
        name.toLowerCase()
    );

  return (
    header?.value ??
    undefined
  );
}

/**
 * Extract readable text from a Gmail message payload.
 *
 * Handles:
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
    payload.mimeType ===
      "text/plain" &&
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
        extractPlainTextBody(
          part
        );

      if (text) {
        return text;
      }
    }
  }

  if (
    payload.mimeType ===
      "text/html" &&
    payload.body?.data
  ) {
    const html =
      Buffer.from(
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