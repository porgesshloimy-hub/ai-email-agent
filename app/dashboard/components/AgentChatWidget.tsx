"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import AgentChatPanel from "./AgentChatPanel";

/**
 * Persistent corner chat widget, mounted once in app/dashboard/layout.tsx
 * (not per-page) so it survives client-side navigation between dashboard
 * routes rather than resetting every time the owner changes pages.
 *
 * Default is collapsed to a small bubble — expands into a floating panel
 * for quick back-and-forth, with a link out to /dashboard/agent-chat for
 * anything needing more room (reviewing longer history, a denser
 * confirmation exchange). Same conversation either way — both surfaces
 * are backed by the same /api/agent-chat route and AgentChatPanel.
 */
export default function AgentChatWidget() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Don't float a second copy of the conversation over the full-page
  // view that already shows it.
  if (pathname === "/dashboard/agent-chat") {
    return null;
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end">
      {open && (
        <div className="mb-3 flex h-[520px] w-[360px] flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="font-display text-sm font-semibold text-ink">Assistant</span>
            <div className="flex items-center gap-1">
              <a
                href="/dashboard/agent-chat"
                className="focus-ring rounded-control px-2 py-1 text-xs font-medium text-muted hover:text-accent-ink"
                title="Open full conversation"
              >
                Expand
              </a>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="focus-ring cursor-pointer rounded-control px-2 py-1 text-muted hover:text-ink"
                aria-label="Close chat"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            <AgentChatPanel compact />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-accent text-white shadow-pop transition-transform hover:scale-105"
        aria-label={open ? "Close assistant chat" : "Open assistant chat"}
      >
        {open ? (
          <span className="text-lg leading-none">✕</span>
        ) : (
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        )}
      </button>
    </div>
  );
}
