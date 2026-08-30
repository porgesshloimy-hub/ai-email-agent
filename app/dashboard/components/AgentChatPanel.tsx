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
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
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
export default function AgentChatPanel({ compact = false }: { compact?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSends, setActiveSends] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Auto-grows the composer with the amount of text entered, up to
   * MAX_TEXTAREA_HEIGHT, beyond which it scrolls internally instead of
   * continuing to grow — previously fixed at one row, relying entirely
   * on native scroll for anything longer. Resetting height to "auto"
   * before measuring scrollHeight is required each time: without it,
   * the browser only ever reports the CURRENT height back, so the box
   * would never shrink again after being grown once (e.g. after
   * clearing the input on send).
   */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

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
    setActiveSends((n) => n + 1);
    setError(null);

    const replyId = replyingTo?.id ?? null;
    const repliedToSnapshot = replyingTo;
    setInput("");
    setReplyingTo(null);

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
     * actually saved. Answers a real question directly: previously
     * there was no way to know a message was reliably sent separately
     * from knowing the agent had finished its whole turn, since one
     * request did both. This is intentionally the smallest possible
     * round trip — no LLM call, just a database write — so the owner's
     * bubble turns solid the moment delivery is actually confirmed,
     * not whenever the agent eventually finishes thinking.
     */
    let confirmedOwnerMessage: ChatMessage;

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
        setActiveSends((n) => n - 1);
        return;
      }

      confirmedOwnerMessage = sendData.ownerMessage;

      // Swap the dimmed placeholder for the real, confirmed row —
      // full color from here on, regardless of how long the agent
      // takes to reply next.
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        confirmedOwnerMessage,
      ]);
    } catch {
      setError("Couldn't reach the server — check your connection and try again.");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(trimmed);
      setReplyingTo(repliedToSnapshot);
      setActiveSends((n) => n - 1);
      return;
    }

    /**
     * PHASE 2 — the actual agent turn. The owner's message is already
     * confirmed and rendered normally at this point; this only ever
     * adds the agent's reply (or reports a failure to reply, which is
     * a different, separate failure from "did my message send"). Not
     * gated on any shared flag, so the owner is free to send another
     * message (starting its own independent Phase 1 + Phase 2) while
     * this one is still waiting on the agent.
     */
    try {
      const res = await fetch("/api/agent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          repliedToMessageId: replyId,
          ownerMessageId: confirmedOwnerMessage.id,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error ?? "Your message sent, but the agent couldn't reply — try again.");
        return;
      }

      setMessages((prev) => [...prev, ...(data.agentMessages ?? [])]);
      requestAnimationFrame(() => scrollToBottom(true));
    } catch {
      setError("Your message sent, but couldn't reach the agent for a reply — try again.");
    } finally {
      setActiveSends((n) => n - 1);
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
             * Bug fix: the scroll container previously used Tailwind's
             * `space-y-3`, which applies a uniform margin between EVERY
             * message via a sibling selector — so grouped bubbles still
             * looked visibly apart even after the inner gap below was
             * tightened, since that outer spacing dominated. Replaced
             * with manual per-message top margin: tight when grouped
             * with the previous message, normal otherwise.
             */
            const prevMsg = messages[index - 1];
            const isGroupedWithPrevious =
              Boolean(prevMsg) &&
              prevMsg.role === msg.role &&
              formatTimeLabel(prevMsg.created_at) === formatTimeLabel(msg.created_at);

            const topMargin = index === 0 ? "" : isGroupedWithPrevious ? "mt-0.5" : "mt-3";

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
                          ? "bg-accent text-white"
                          : "border border-line bg-surface text-ink"
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
            onChange={(e) => setInput(e.target.value)}
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
        {activeSends > 0 && (
          <p className="mt-1.5 px-1 text-[11px] text-muted">
            {activeSends === 1 ? "Waiting on a reply…" : `Waiting on ${activeSends} replies…`}
          </p>
        )}
      </div>
    </div>
  );
}
