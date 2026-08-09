import { createServerSupabase } from "@/lib/supabase/server";

export default async function SettingsPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tenant } = await supabase.from("tenants").select("*").eq("owner_user_id", user?.id).single();

  const { data: gmailConnection } = await supabase
    .from("gmail_connections")
    .select("gmail_address, connected_at")
    .eq("tenant_id", tenant?.id)
    .single();

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Business & Gmail</h1>

      <section style={{ marginBottom: 32 }}>
        <h2>Gmail connection</h2>
        {gmailConnection ? (
          <p>Connected as {gmailConnection.gmail_address}</p>
        ) : (
          <a href="/api/auth/gmail">
            <button style={{ padding: "8px 16px" }}>Connect Gmail</button>
          </a>
        )}
      </section>

      <section>
        <h2>Business information</h2>
        {/* Form wiring omitted — POST to a server action or route handler that
            upserts tenants.business_name / business_description. */}
        <p>Business name: {tenant?.business_name ?? "—"}</p>
        <p>Description: {tenant?.business_description ?? "—"}</p>
      </section>
    </main>
  );
}
