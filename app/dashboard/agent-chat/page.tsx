import AgentChatPanel from "@/app/dashboard/components/AgentChatPanel";

export default function AgentChatPage() {
  return (
    <div className="mx-auto max-w-[880px] px-6 py-8 sm:px-8">
      <div className="mb-4">
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">Assistant</h1>
        <p className="mt-1 text-sm text-muted">
          Talk to your assistant directly — ask about pending items, set reminders, or book
          something on your calendar.
        </p>
      </div>

      <div className="h-[70vh] overflow-hidden rounded-panel border border-line bg-surface shadow-panel">
        <AgentChatPanel />
      </div>
    </div>
  );
}
