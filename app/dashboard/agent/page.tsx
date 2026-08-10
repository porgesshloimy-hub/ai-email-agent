import { createServerSupabase } from "@/lib/supabase/server";
import type { AgentAction } from "@/types";

const EMAIL_ACTIONS: { key: AgentAction; label: string }[] = [
  { key: "gmail.read", label: "Read / search email" },
  { key: "gmail.draft", label: "Create drafts" },
  { key: "gmail.send", label: "Send email" },
  { key: "gmail.archive", label: "Archive" },
  { key: "gmail.delete", label: "Delete" },
];

const CALENDAR_ACTIONS: { key: AgentAction; label: string }[] = [
  { key: "calendar.read", label: "Read calendar / check availability" },
  { key: "calendar.write", label: "Create / modify events" },
];

export default async function AgentPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tenant } = await supabase.from("tenants").select("id").eq("owner_user_id", user?.id).single();

  const { data: config } = await supabase
    .from("agent_configs")
    .select("custom_instructions, rules")
    .eq("tenant_id", tenant?.id)
    .single();

  const { data: permissions } = await supabase
    .from("agent_permissions")
    .select("action, level")
    .eq("tenant_id", tenant?.id);

  const levelFor = (action: string) => permissions?.find((p) => p.action === action)?.level ?? "approval_required";

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Agent setup</h1>

      <section style={{ marginBottom: 32 }}>
        <h2>Instructions</h2>
        {/* Textarea bound to a server action that updates agent_configs.custom_instructions */}
        <textarea
          defaultValue={config?.custom_instructions ?? ""}
          rows={4}
          style={{ width: "100%" }}
          placeholder='e.g. "We are a plumbing company in Brooklyn. Automatically answer basic pricing questions."'
        />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2>Email permissions</h2>
        <table>
          <tbody>
            {EMAIL_ACTIONS.map((a) => (
              <tr key={a.key}>
                <td>{a.label}</td>
                <td>
                  {/* Radio group bound to a server action that upserts agent_permissions */}
                  <select defaultValue={levelFor(a.key)}>
                    <option value="denied">Never</option>
                    <option value="approval_required">Draft only — I approve before sending</option>
                    <option value="allowed">Automatic</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 13, color: "#666" }}>
          When "Send" is set to draft-only, the agent never sends on its own — it prepares a draft in your Gmail and
          notifies you to review it.
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2>Calendar permissions</h2>
        <table>
          <tbody>
            {CALENDAR_ACTIONS.map((a) => (
              <tr key={a.key}>
                <td>{a.label}</td>
                <td>
                  <select defaultValue={levelFor(a.key)}>
                    <option value="denied">Never</option>
                    <option value="approval_required">Propose only — I confirm before it's booked</option>
                    <option value="allowed">Automatic</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 13, color: "#666" }}>
          When "Create / modify events" is set to propose-only, the agent never books anything directly — it queues a
          suggested event on the Approvals page for you to confirm.
        </p>
      </section>

      <section>
        <h2>Rules</h2>
        <ul>
          {(config?.rules as { description: string }[] | undefined)?.map((r, i) => <li key={i}>{r.description}</li>)}
        </ul>
        {/* Add-rule form omitted — appends to agent_configs.rules jsonb */}
      </section>
    </main>
  );
}
