import { createServerSupabase } from "@/lib/supabase/server";
import { approveAndSend, rejectDraft, confirmCalendarEvent, confirmZoomMeeting, dismissCalendarEvent } from "./actions";

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
    <main style={{ maxWidth: 640, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Waiting for your review</h1>
      {nothingPending && <p>Nothing pending — you're caught up.</p>}

      {pendingEmails && pendingEmails.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2>Email drafts</h2>
          {pendingEmails.map((action) => (
            <div key={action.id} style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              {action.reasoning && <p style={{ fontSize: 13, color: "#666" }}>Agent's note: {action.reasoning}</p>}
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{action.draft_content}</pre>
              <form action={approveAndSend} style={{ display: "inline" }}>
                <input type="hidden" name="actionId" value={action.id} />
                <button type="submit">Approve & send</button>
              </form>
              <form action={rejectDraft} style={{ display: "inline", marginLeft: 8 }}>
                <input type="hidden" name="actionId" value={action.id} />
                <button type="submit">Reject</button>
              </form>
            </div>
          ))}
        </section>
      )}

      {pendingEvents && pendingEvents.length > 0 && (
        <section>
          <h2>Proposed calendar events</h2>
          {pendingEvents.map((action) => {
            const isZoom = action.action_type === "create_zoom_meeting";

            return (
              <div key={action.id} style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong>{action.proposed_summary}</strong>
                  {isZoom && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#2D8CFF",
                        background: "#eaf3ff",
                        padding: "2px 6px",
                        borderRadius: 4,
                      }}
                    >
                      ZOOM
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 13, color: "#666" }}>
                  {new Date(action.proposed_start).toLocaleString()} — {new Date(action.proposed_end).toLocaleString()}
                </p>
                {action.reasoning && <p style={{ fontSize: 13, color: "#666" }}>Agent's note: {action.reasoning}</p>}
                <form action={isZoom ? confirmZoomMeeting : confirmCalendarEvent} style={{ display: "inline" }}>
                  <input type="hidden" name="actionId" value={action.id} />
                  <button type="submit">{isZoom ? "Confirm & create meeting" : "Confirm & book"}</button>
                </form>
                <form action={dismissCalendarEvent} style={{ display: "inline", marginLeft: 8 }}>
                  <input type="hidden" name="actionId" value={action.id} />
                  <button type="submit">Dismiss</button>
                </form>
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}