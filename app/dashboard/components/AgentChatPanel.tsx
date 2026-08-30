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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function findMessageById(id: string | null): ChatMessage | undefined {
    if (!id) return undefined;
    return messages.find((m) => m.id === id);
  }

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setError(null);

    const replyId = replyingTo?.id ?? null;
    const repliedToSnapshot = replyingTo;
    setInput("");
    setReplyingTo(null);

    // Show the owner's own message immediately rather than waiting for
    // the agent's reply — the temp id is reconciled with the real
    // persisted row once the request resolves, so reply-to targeting
    // against it still works correctly afterward.
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

    try {
      const res = await fetch("/api/agent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, repliedToMessageId: replyId }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error ?? "Something went wrong sending that.");
        // Roll back the optimistic message and restore the draft so
        // nothing typed is lost on failure.
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setInput(trimmed);
        setReplyingTo(repliedToSnapshot);
        return;
      }

      // Replace the optimistic placeholder with the real persisted row
      // (real id, real timestamp) and append every agent-reply message
      // for this turn — a reply can arrive as more than one message
      // (see lib/agent/chat.ts's message-splitting comment), each
      // rendered as its own bubble in order.
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        data.ownerMessage,
        ...(data.agentMessages ?? []),
      ]);
    } catch {
      setError("Couldn't reach the agent — check your connection and try again.");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(trimmed);
      setReplyingTo(repliedToSnapshot);
    } finally {
      setSending(false);
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
        className={`flex-1 space-y-3 overflow-y-auto overflow-x-hidden ${compact ? "px-3 py-3" : "px-6 py-6"}`}
      >
        {loading ? (
          <p className="text-sm text-muted">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing here yet — ask about a booking, a reminder, or anything pending.
          </p>
        ) : (
          messages.map((msg) => {
            const isOwner = msg.role === "owner";
            const repliedTo = findMessageById(msg.replied_to_message_id);

            return (
              <div key={msg.id} className={`group flex min-w-0 ${isOwner ? "justify-end" : "justify-start"}`}>
                <div className={`flex min-w-0 max-w-[85%] flex-col gap-1 ${isOwner ? "items-end" : "items-start"}`}>
                  {repliedTo && (
                    <div className="max-w-full rounded-control border-l-2 border-line bg-surface-2 px-2.5 py-1 text-xs text-muted break-words">
                      {repliedTo.content.slice(0, 60)}
                      {repliedTo.content.length > 60 ? "…" : ""}
                    </div>
                  )}

                  <div
                    className={`max-w-full whitespace-pre-wrap break-words rounded-panel px-3.5 py-2.5 text-sm leading-relaxed shadow-panel ${
                      isOwner
                        ? "bg-accent text-white"
                        : "border border-line bg-surface text-ink"
                    } ${msg.pending ? "opacity-60" : ""}`}
                  >
                    {renderInlineMarkdown(msg.content)}
                  </div>

                  <div className="flex items-center gap-2 px-1">
                    <span className="text-[11px] text-muted">{formatTimeLabel(msg.created_at)}</span>
                    <button
                      type="button"
                      onClick={() => setReplyingTo(msg)}
                      className="focus-ring cursor-pointer rounded-control text-[11px] font-medium text-muted opacity-0 transition-opacity hover:text-accent-ink group-hover:opacity-100"
                    >
                      Reply
                    </button>
                  </div>
                </div>
              </div>
            );
          })
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Say something"
            rows={1}
            disabled={sending}
            className="focus-ring min-h-[40px] flex-1 resize-none rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted"
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={sending || !input.trim()}
            className="focus-ring shrink-0 cursor-pointer rounded-control bg-accent px-4 py-2 text-sm font-medium text-white shadow-panel transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
