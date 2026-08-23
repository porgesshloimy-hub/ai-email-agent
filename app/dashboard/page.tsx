import { createServerSupabase } from "@/lib/supabase/server";
import Link from "next/link";

export default async function DashboardPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  console.log("AUTH USER:", user);

  const { data: tenant } = await supabase.from("tenants").select("*").eq("owner_user_id", user?.id).single();

  /**
   * Bug fix (2026-08-21): this used to count every email_actions row
   * with status "pending_approval", regardless of action_type. But
   * propose_calendar_event/propose_zoom_meeting each write a
   * action_type "calendar_proposal" mirror row into email_actions
   * alongside the real proposal in calendar_actions — and, until the
   * fix in app/dashboard/approvals/actions.ts, nothing ever updated
   * that mirror row once the real proposal was approved or dismissed.
   * The result: this count included permanently-orphaned mirror rows
   * that the approvals page (which only ever shows action_type
   * "draft_reply" email actions, plus calendar_actions directly — see
   * app/dashboard/approvals/page.tsx) would never display, so the
   * dashboard could say "8 waiting" while the approvals page showed
   * nothing to review at all.
   *
   * Fix: count exactly what the approvals page actually shows —
   * pending draft replies AND pending calendar/Zoom proposals — instead
   * of "any pending_approval row regardless of type." This can't drift
   * out of sync with what's actually reviewable even if something else
   * mirrors a status elsewhere in the future, since it no longer trusts
   * an unfiltered status count as a proxy for "actionable items."
   */
  const { count: pendingDraftCount } = await supabase
    .from("email_actions")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant?.id)
    .eq("status", "pending_approval")
    .eq("action_type", "draft_reply");

  const { count: pendingEventCount } = await supabase
    .from("calendar_actions")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant?.id)
    .eq("status", "pending_approval");

  const pendingCount = (pendingDraftCount ?? 0) + (pendingEventCount ?? 0);

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>{tenant?.business_name ?? "Your business"}</h1>
      <p>
        <Link href="/dashboard/approvals">{pendingCount} drafts waiting for your review</Link>
      </p>
      <nav style={{ display: "flex", gap: 16 }}>
        <Link href="/dashboard/settings">Connections</Link>
        <Link href="/dashboard/agent">Agent Instructions & Permissions</Link>
        <Link href="/dashboard/approvals">Approvals</Link>
        <Link href="/dashboard/billing">Usage & billing</Link>
      </nav>
    </main>
  );
}
