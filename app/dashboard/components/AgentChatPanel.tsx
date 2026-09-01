"use client";

import { Fragment, useEffect, useRef, useState } from "react";

export interface ChatMessage {
  id: string;
  role: "owner" | "agent";
  content: string;
  replied_to_message_id: string | null;
  created_at: string;
  /** Client-only flag for an optimistically-rendered message not yet confirmed by the server. */
  pending?: boolean;
}

/**
 * The agent's replies come back with markdown-style emphasis
 * (**bold**, *italic*, `code`) — found in production when a calendar
 * summary rendered with literal asterisks instead of bold text. Rather
 * than pull in a full markdown library for what's just inline emphasis
 * inside a chat bubble (no headers, lists, links, or tables needed
 * here), this is a small, dependency-free tokenizer. It builds React
 * elements directly rather than using dangerouslySetInnerHTML, so
 * there's no HTML-injection surface even though this content comes
 * from the model rather than a trusted static string.
 */
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
  const parts = text.split(pattern);

  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:opacity-80"
        >
          {part}
        </a>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function formatTimeLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The shared conversation surface — message list plus composer. Used
 * both by AgentChatWidget's compact corner panel and by the standalone
 * /dashboard/agent-chat page, which just render this inside different
 * chrome (a floating card vs. a full-width page container).
 */
export default function AgentChatPanel({
  compact = false,
  isOpen = true,
}: {
  compact?: boolean;
  isOpen?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingPingRef = useRef(0);

  /**
   * Bug fix: the initial "load history + scroll to bottom" effect
   * below has an empty dependency array — it only ever fires once, on
   * the panel's very first mount. That was fine when the widget
   * unmounted/remounted the panel on every open (each open was a fresh
   * mount, so it re-fired every time), but since the panel now stays
   * permanently mounted (see AgentChatWidget.tsx's fix for the
   * polling-abandonment bug), reopening the popup never re-triggered
   * it — the scroll position just stayed wherever it was left, so a
   * reopen could show the top of the conversation, with any new
   * messages that arrived in the meantime sitting off-screen below,
   * looking like they weren't showing up at all. This gives "the popup
   * just opened" its own real trigger, mirroring the same pattern
   * already used for the typing indicator's own appearance below.
   */
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => scrollToBottom(false));
    }
  }, [isOpen]);

  /**
   * Scrolls into view the moment the typing indicator appears —
   * previously it could show up (typically before any message has
   * actually arrived yet) with no scroll triggered, since all the
   * existing scroll calls were tied to messages being appended, not to
   * the indicator's own visibility. This is a separate, dedicated
   * effect specifically for that gap, independent of the
   * message-append scroll calls elsewhere (which still need to stay
   * separate — loadOlderMessages deliberately does NOT scroll to
   * bottom, since it preserves scroll position when prepending older
   * history instead).
   */
  useEffect(() => {
    if (isAgentTyping) {
      scrollToBottom(true);
    }
  }, [isAgentTyping]);

  /**
   * Pings the server that the owner is actively typing, throttled to
   * at most once every ~2 seconds — the backend
   * (lib/inngest/functions.ts's processDelayedChatReply) uses freshness
   * of this signal to decide whether to keep waiting before responding,
   * rather than just reacting to whether another message has actually
   * been sent yet.
   */
  function pingTyping() {
    const now = Date.now();
    if (now - lastTypingPingRef.current < 2000) return;
    lastTypingPingRef.current = now;
    fetch("/api/agent-chat/typing", { method: "POST" }).catch(() => {
      // Best-effort — a missed ping just means the server's typing
      // freshness check expires a little early; not worth surfacing.
    });
  }

  /**
   * Auto-grows the composer with the amount of text entered, up to
   * MAX_TEXTAREA_HEIGHT, beyond which it scrolls internally instead of
   * continuing to grow — previously fixed at one row, relying entirely
   * on native scroll for anything longer. Resetting height to "auto"
   * before measuring scrollHeight is required each time: without it,
   * the browser only ever reports the CURRENT height back, so the box
   * would never shrink again after being grown once (e.g. after
   * clearing the input on send).
   *
   * Bug fix: AgentChatWidget.tsx now keeps this panel permanently
   * mounted, toggling only CSS visibility (display:none) when the
   * popup is closed — a real fix for a worse bug (polling being
   * silently abandoned on unmount), but it introduced this one: a
   * `display:none` element always reports `scrollHeight: 0`. If
   * `input` happened to change (e.g. clearing to "" right after a
   * send) while the widget was closed, this effect would compute
   * against that bogus zero height and set a broken inline
   * `style.height` that then persisted — visually corrupting the
   * composer the moment the widget reopened, since an inline style
   * isn't affected by the CSS class toggle that controls visibility.
   * `el.offsetParent === null` reliably detects "this element (or an
   * ancestor) is currently display:none," so the broken calculation is
   * simply skipped while hidden — nothing needs correcting on reopen,
   * since the height was already correct from before the widget closed
   * and is no longer being overwritten with garbage in the meantime.
   */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (el.offsetParent === null) return; // hidden — skip, see bug-fix note above

    const MAX_TEXTAREA_HEIGHT = 160; // px, roughly 7 lines

    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/agent-chat")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
        } else {
          setMessages(data.messages ?? []);
          setHasMore(Boolean(data.hasMore));
          requestAnimationFrame(() => scrollToBottom(false));
        }
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load chat history.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Loads an older page of history, per the request for the FULL
   * conversation to be reachable in the UI — deliberately separate from
   * lib/agent/chat-history's model-context cap (which stays small for
   * cost reasons; see that module). Fetching more history for a human
   * to read has no LLM-cost implication, so there's no reason to bound
   * it the same way — this just paginates rather than loading
   * everything in one request, which would be slow for a long-lived
   * account.
   */
  async function loadOlderMessages() {
    if (loadingMore || messages.length === 0) return;

    setLoadingMore(true);
    const oldest = messages[0];
    const previousScrollHeight = scrollRef.current?.scrollHeight ?? 0;

    try {
      const res = await fetch(`/api/agent-chat?before=${encodeURIComponent(oldest.created_at)}`);
      const data = await res.json();

      if (data.error) {
        setError(data.error);
        return;
      }

      setMessages((prev) => [...(data.messages ?? []), ...prev]);
      setHasMore(Boolean(data.hasMore));

      // Preserve scroll position — without this, prepending older
      // messages would visually yank the view down to match the new
      // (taller) scroll height.
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight - previousScrollHeight;
        }
      });
    } catch {
      setError("Couldn't load earlier messages.");
    } finally {
      setLoadingMore(false);
    }
  }

  function scrollToBottom(smooth = true) {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }

  function findMessageById(id: string | null): ChatMessage | undefined {
    if (!id) return undefined;
    return messages.find((m) => m.id === id);
  }

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Deliberately NOT a shared blocking flag — allows sending another
    // message while a previous one's agent reply is still in flight.
    // Each call is self-contained (its own tempId/closures), and all
    // shared-state updates use the functional setState form, so
    // multiple overlapping sends are safe to run concurrently.
    setError(null);

    const replyId = replyingTo?.id ?? null;
    const repliedToSnapshot = replyingTo;
    setInput("");
    setReplyingTo(null);
    // Removes focus from the composer right after sending — the owner
    // just finished a thought; the box shouldn't sit visually "active"
    // while the reply is pending.
    textareaRef.current?.blur();

    // Shown immediately, dimmed, while we confirm it was actually
    // saved — a genuinely unconfirmed state, not just "waiting on the
    // agent." See the two-phase flow below for what resolves it.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticMessage: ChatMessage = {
      id: tempId,
      role: "owner",
      content: trimmed,
      replied_to_message_id: replyId,
      created_at: new Date().toISOString(),
      pending: true,
    };
    setMessages((prev) => [...prev, optimisticMessage]);
    requestAnimationFrame(() => scrollToBottom(true));

    /**
     * PHASE 1 — fast, separate confirmation that the message was
     * actually saved, AND that it's either being answered instantly
     * (a confirmation reply) or has been reliably scheduled for a
     * delayed reply (a genuine new message) — this endpoint now
     * decides that too, and scheduling itself is a fast network call
     * to Inngest, not a wait on the agent, so "this will be answered
     * and won't get stuck" is known right away, well before any
     * artificial delay begins.
     */
    try {
      const sendRes = await fetch("/api/agent-chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, repliedToMessageId: replyId }),
      });

      const sendData = await sendRes.json();

      if (!sendRes.ok || sendData.error) {
        setError(sendData.error ?? "Something went wrong sending that.");
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setInput(trimmed);
        setReplyingTo(repliedToSnapshot);
        return;
      }

      const confirmedOwnerMessage: ChatMessage = sendData.ownerMessage;

      // Swap the dimmed placeholder for the real, confirmed row —
      // full color from here on, regardless of how long the agent
      // takes to reply next.
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        confirmedOwnerMessage,
      ]);

      if (sendData.immediateReply) {
        // Confirmation-reply case: already generated and persisted
        // synchronously by the send endpoint — fetch the resulting
        // row(s) once, immediately, rather than reusing the polling
        // loop below (which starts with a 2s sleep unsuited to
        // something that's already done).
        setIsAgentTyping(true);
        try {
          const res = await fetch(
            `/api/agent-chat?after=${encodeURIComponent(confirmedOwnerMessage.created_at)}`
          );
          const data = await res.json();
          setMessages((prev) => [...prev, ...(data.messages ?? [])]);
          requestAnimationFrame(() => scrollToBottom(true));
        } catch {
          setError("Your message sent, but couldn't load the reply — refresh to see it.");
        } finally {
          setIsAgentTyping(false);
        }
        return;
      }

      if (sendData.scheduled) {
        await pollForNewMessages(confirmedOwnerMessage.created_at);
      }
    } catch {
      setError("Couldn't reach the server — check your connection and try again.");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(trimmed);
      setReplyingTo(repliedToSnapshot);
    }
  }

  /**
   * PHASE 2 — polls for the agent's eventual reply rather than holding
   * one long HTTP request open. Necessary once replies became
   * asynchronous (a typing-aware wait, batched with any follow-up sent
   * during that window — see lib/inngest/functions.ts's
   * processDelayedChatReply): a single blocking request risks Vercel's
   * function duration limit once a follow-up message extends the
   * effective wait, and two separate browser requests (for two
   * messages sent close together) can't otherwise learn they were
   * merged into one combined reply server-side.
   *
   * The typing indicator is driven entirely by the server's real
   * `agentReplying` status (GET /api/agent-chat's `?after=` response),
   * not client-side guessing. Two previous guesses are gone:
   *   - A fixed 2-4s delay before first showing "typing" — wrong
   *     whenever the server's Phase B turned out to be the longer
   *     5-9s branch, since the client had no way to know which branch
   *     the server picked. Now the indicator shows at the exact moment
   *     `agentReplying` flips true, which is the exact moment
   *     generation actually starts, regardless of how long the wait
   *     before it was.
   *   - A quiet-period heuristic ("no new part for ~4.5s ⇒ probably
   *     done") for deciding a multi-part reply had finished — an
   *     inherently imprecise guess that could show a dangling "typing"
   *     after the true last part, or occasionally cut off early. Now
   *     the reply is known to be finished the instant `agentReplying`
   *     flips back to false — an exact signal, not a guess.
   */
  async function pollForNewMessages(sinceTimestamp: string) {
    const POLL_INTERVAL_MS = 1000;
    const MAX_POLL_MS = 120_000;

    console.log("POLLING STARTED:", { sinceTimestamp });

    const startedAt = Date.now();
    let cursor = sinceTimestamp;
    let everSeenReplying = false;

    try {
      while (Date.now() - startedAt < MAX_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        try {
          const res = await fetch(`/api/agent-chat?after=${encodeURIComponent(cursor)}`);

          if (!res.ok) {
            console.error("POLL REQUEST FAILED:", { status: res.status, statusText: res.statusText });
            continue;
          }

          const data = await res.json();

          if (data.error) {
            console.error("POLL RESPONSE ERROR:", data.error);
            continue; // transient — keep polling rather than surfacing every hiccup
          }

          const agentReplying = Boolean(data.agentReplying);
          setIsAgentTyping(agentReplying);
          if (agentReplying) everSeenReplying = true;

          const newMessages: ChatMessage[] = data.messages ?? [];

          if (newMessages.length > 0) {
            console.log("POLL FOUND NEW MESSAGES:", { count: newMessages.length });
            setMessages((prev) => {
              const existingIds = new Set(prev.map((m) => m.id));
              const toAdd = newMessages.filter((m) => !existingIds.has(m.id));
              return [...prev, ...toAdd];
            });
            requestAnimationFrame(() => scrollToBottom(true));

            cursor = newMessages[newMessages.length - 1].created_at;
          }

          // Was actively replying at some point, and has now genuinely
          // stopped — the reply is complete. An exact signal, not a
          // guess about timing.
          if (everSeenReplying && !agentReplying) {
            console.log("POLLING COMPLETE: reply finished normally");
            return;
          }
        } catch (err) {
          // Previously fully silent — made visible now specifically
          // because "messages don't show up until closing and
          // reopening the widget" needs real evidence to diagnose
          // further, not another guess.
          console.error("POLL REQUEST THREW:", err);
        }
      }

      if (!everSeenReplying) {
        console.warn("POLLING TIMED OUT: never observed agentReplying=true within MAX_POLL_MS");
        setError("The agent is taking longer than expected — it may still reply shortly.");
      }
    } finally {
      setIsAgentTyping(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        className={`flex-1 overflow-y-auto overflow-x-hidden ${compact ? "px-3 py-3" : "px-6 py-6"}`}
      >
        {loading ? (
          <p className="text-sm text-muted">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing here yet — ask about a booking, a reminder, or anything pending.
          </p>
        ) : (
          <>
            {hasMore && (
              <div className="flex justify-center pb-2">
                <button
                  type="button"
                  onClick={loadOlderMessages}
                  disabled={loadingMore}
                  className="focus-ring cursor-pointer rounded-control px-3 py-1 text-xs font-medium text-muted hover:text-accent-ink disabled:cursor-default disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load earlier messages"}
                </button>
              </div>
            )}
            {messages.map((msg, index) => {
            const isOwner = msg.role === "owner";
            const repliedTo = findMessageById(msg.replied_to_message_id);

            /**
             * Collapses the timestamp across a consecutive run of
             * same-role messages sent at the same displayed time (the
             * common case: a single split reply persisted as several
             * rows a few milliseconds apart — see lib/agent/chat.ts's
             * message-splitting comment). Only the LAST message in such
             * a run shows a time label, matching how most chat apps
             * group a rapid-fire burst under one timestamp rather than
             * repeating it under every bubble. The Reply button is
             * unaffected by this — it still renders on every message
             * individually, since replying to the second message in a
             * burst rather than the last one is still a meaningful,
             * distinct action.
             */
            const nextMsg = messages[index + 1];
            const showTimestamp =
              !nextMsg ||
              nextMsg.role !== msg.role ||
              formatTimeLabel(nextMsg.created_at) !== formatTimeLabel(msg.created_at);

            /**
             * Spacing fix: this used to give consecutive same-time
             * messages a tighter "mt-1.5" margin (mainly affecting the
             * agent's own multi-part split replies, since the owner
             * rarely sends two messages within the same displayed
             * minute) versus "mt-3" otherwise — reported as the agent's
             * side feeling more cramped than the owner's. Now uniform:
             * every message gets the same spacing regardless of
             * grouping. (The forward-looking `showTimestamp` check
             * above is a separate, unrelated concern from this vertical
             * spacing — it's unaffected by this change.)
             */
            const topMargin = index === 0 ? "" : "mt-1";

            return (
              <div
                key={msg.id}
                className={`group flex min-w-0 ${topMargin} ${isOwner ? "justify-end" : "justify-start"}`}
              >
                <div className={`flex min-w-0 max-w-[85%] flex-col ${isOwner ? "items-end" : "items-start"} ${showTimestamp ? "gap-1" : "gap-0"}`}>
                  {repliedTo && (
                    <div className="max-w-full rounded-control border-l-2 border-line bg-surface-2 px-2.5 py-1 text-xs text-muted break-words">
                      {repliedTo.content.slice(0, 60)}
                      {repliedTo.content.length > 60 ? "…" : ""}
                    </div>
                  )}

                  {/*
                    Reply moved off the document flow entirely (absolute
                    positioning on this relative wrapper) so it costs
                    zero layout space — previously a permanent row below
                    every bubble, which kept grouped/same-time bubbles
                    visibly apart even with the timestamp hidden. It now
                    overlays the bubble's outer corner, appearing only
                    on hover of that specific message.
                  */}
                  <div className="relative max-w-full">
                    <div
                      className={`max-w-full whitespace-pre-wrap break-words rounded-panel px-3.5 py-2.5 text-sm leading-relaxed shadow-panel ${
                        isOwner
                          ? "bg-blue-100 text-ink"
                          : "bg-[#ECEEF1] text-ink"
                      } ${msg.pending ? "opacity-60" : ""}`}
                    >
                      {renderInlineMarkdown(msg.content)}
                    </div>

                    <button
                      type="button"
                      onClick={() => setReplyingTo(msg)}
                      title="Quote in reply"
                      aria-label="Reply to this message"
                      className={`focus-ring absolute -bottom-1.5 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-[12px] text-muted opacity-0 shadow-panel transition-opacity hover:text-accent-ink group-hover:opacity-100 ${
                        isOwner ? "-left-1.5" : "-right-1.5"
                      }`}
                    >
                      ↩
                    </button>
                  </div>

                  {showTimestamp && (
                    <span className="px-1 text-[11px] text-muted">{formatTimeLabel(msg.created_at)}</span>
                  )}
                </div>
              </div>
            );
          })}
          {isAgentTyping && (
            <div className="mt-3 flex justify-start">
              <div className="flex items-center gap-1 rounded-panel bg-[#ECEEF1] px-3.5 py-2.5 shadow-panel">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
              </div>
            </div>
          )}
          </>
        )}
      </div>

      {error && (
        <div className="border-t border-line bg-danger-soft px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="border-t border-line bg-surface px-3 py-3">
        {replyingTo && (
          <div className="mb-2 flex items-center justify-between rounded-control border-l-2 border-line bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">
            <span className="truncate">
              {replyingTo.content.slice(0, 70)}
              {replyingTo.content.length > 70 ? "…" : ""}
            </span>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="focus-ring ml-2 shrink-0 cursor-pointer rounded-control text-muted hover:text-ink"
              aria-label="Cancel reply"
            >
              ✕
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (e.target.value.trim()) pingTyping();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Say something"
            rows={1}
            className="focus-ring max-h-[160px] flex-1 resize-none rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted"
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={!input.trim()}
            className="focus-ring shrink-0 cursor-pointer rounded-control bg-accent px-4 py-2 text-sm font-medium text-white shadow-panel transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
