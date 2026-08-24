import { createServerSupabase } from "@/lib/supabase/server";
import { approveAndSend, rejectDraft, confirmCalendarEvent, confirmZoomMeeting, dismissCalendarEvent } from "./actions";
import {
  Badge,
  Button,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  SectionHeading,
} from "@/components/ui";

export default async function ApprovalsPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tenant } = await supabase.from("tenants").select("id").eq("owner_user_id", user?.id).single();

  const { data: pendingEmails } = await supabase
    .from("email_actions")
    .select("*")
    .eq("tenant_id", tenant?.id)
    .eq("status", "pending_approval")
    .eq("action_type", "draft_reply")
    .order("created_at", { ascending: false });

  const { data: pendingEvents } = await supabase
    .from("calendar_actions")
    .select("*")
    .eq("tenant_id", tenant?.id)
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false });

  const nothingPending = (!pendingEmails || pendingEmails.length === 0) && (!pendingEvents || pendingEvents.length === 0);

  return (
    <Page>
      <PageHeader
        eyebrow="Approvals"
        title="Waiting for your review"
        description="Nothing here goes out until you approve it. Drafts already exist in your Gmail."
      />

      {nothingPending && (
        <EmptyState
          title="Nothing pending"
          description="You're caught up. New drafts and proposed meetings will appear here as soon as the agent creates them."
        />
      )}

      {pendingEmails && pendingEmails.length > 0 && (
        <section className="mb-12">
          <SectionHeading
            title="Email drafts"
            description="Approve to send from your connected Gmail address."
            actions={<Badge tone="accent">{pendingEmails.length} pending</Badge>}
          />

          <div className="flex flex-col gap-4">
            {pendingEmails.map((action) => (
              <Panel key={action.id} padding="lg">
                {action.reasoning && (
                  <p className="mb-4 rounded-control bg-surface-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
                    <span className="font-semibold text-muted">Agent's note · </span>
                    {action.reasoning}
                  </p>
                )}

                <pre className="whitespace-pre-wrap font-sans text-[15px] leading-relaxed text-ink">
                  {action.draft_content}
                </pre>

                <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-5">
                  <form action={approveAndSend}>
                    <input type="hidden" name="actionId" value={action.id} />
                    <Button type="submit">Approve &amp; send</Button>
                  </form>

                  <form action={rejectDraft}>
                    <input type="hidden" name="actionId" value={action.id} />
                    <Button type="submit" variant="ghost">
                      Reject
                    </Button>
                  </form>
                </div>
              </Panel>
            ))}
          </div>
        </section>
      )}

      {pendingEvents && pendingEvents.length > 0 && (
        <section>
          <SectionHeading
            title="Proposed calendar events"
            description="Confirm to book on your calendar."
            actions={<Badge tone="accent">{pendingEvents.length} pending</Badge>}
          />

          <div className="flex flex-col gap-4">
            {pendingEvents.map((action) => {
              const isZoom = action.action_type === "create_zoom_meeting";

              return (
                <Panel key={action.id} padding="lg">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <strong className="font-display text-[15px] font-semibold text-ink">
                      {action.proposed_summary}
                    </strong>
                    {isZoom && <Badge tone="accent">Zoom</Badge>}
                  </div>

                  <p className="mt-2 text-[13px] text-muted">
                    {new Date(action.proposed_start).toLocaleString()} —{" "}
                    {new Date(action.proposed_end).toLocaleString()}
                  </p>

                  {action.reasoning && (
                    <p className="mt-4 rounded-control bg-surface-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-2">
                      <span className="font-semibold text-muted">Agent's note · </span>
                      {action.reasoning}
                    </p>
                  )}

                  <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-5">
                    <form action={isZoom ? confirmZoomMeeting : confirmCalendarEvent}>
                      <input type="hidden" name="actionId" value={action.id} />
                      <Button type="submit">
                        {isZoom ? "Confirm & create meeting" : "Confirm & book"}
                      </Button>
                    </form>

                    <form action={dismissCalendarEvent}>
                      <input type="hidden" name="actionId" value={action.id} />
                      <Button type="submit" variant="ghost">
                        Dismiss
                      </Button>
                    </form>
                  </div>
                </Panel>
              );
            })}
          </div>
        </section>
      )}
    </Page>
  );
}
