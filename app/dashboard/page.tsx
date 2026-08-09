import { createServerSupabase } from "@/lib/supabase/server";
import Link from "next/link";

export default async function DashboardPage() {
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tenant } = await supabase.from("tenants").select("*").eq("owner_user_id", user?.id).single();

  const { count: pendingCount } = await supabase
    .from("email_actions")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant?.id)
    .eq("status", "pending_approval");

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>{tenant?.business_name ?? "Your business"}</h1>
      <p>
        <Link href="/dashboard/approvals">{pendingCount ?? 0} drafts waiting for your review</Link>
      </p>
      <nav style={{ display: "flex", gap: 16 }}>
        <Link href="/dashboard/settings">Business & Gmail settings</Link>
        <Link href="/dashboard/agent">Agent instructions & permissions</Link>
        <Link href="/dashboard/approvals">Approvals</Link>
      </nav>
    </main>
  );
}
