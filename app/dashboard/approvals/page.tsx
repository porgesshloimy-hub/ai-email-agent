import { createServerSupabase } from "@/lib/supabase/server";
import { approveAndSend, rejectDraft } from "./actions";

export default async function ApprovalsPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tenant } = await supabase.from("tenants").select("id").eq("owner_user_id", user?.id).single();

  const { data: pending } = await supabase
    .from("email_actions")
    .select("*")
    .eq("tenant_id", tenant?.id)
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false });

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Drafts waiting for review</h1>
      {(!pending || pending.length === 0) && <p>Nothing pending — you're caught up.</p>}

      {pending?.map((action) => (
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
    </main>
  );
}
