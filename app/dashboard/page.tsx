import { createServerSupabase } from "@/lib/supabase/server";
import Link from "next/link";
import {
  Badge,
  Bento,
  BentoItem,
  Page,
  PageHeader,
  Panel,
  PanelTitle,
  Stat,
} from "@/components/ui";

const SHORTCUTS = [
  {
    href: "/dashboard/settings",
    title: "Connections",
    text: "Gmail, Google Calendar and Zoom accounts linked to this workspace.",
  },
  {
    href: "/dashboard/agent",
    title: "Agent instructions & permissions",
    text: "What the agent knows, what it may do alone, and what needs approval.",
  },
  {
    href: "/dashboard/settings/knowledge",
    title: "Business knowledge",
    text: "Documents and facts the agent uses to answer accurately.",
  },
  {
    href: "/dashboard/billing",
    title: "Usage & billing",
    text: "Emails handled, actions taken and your current plan.",
  },
];

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
   * propose_calendar_event/propose_zoom_meeting each write an
   * action_type "calendar_proposal" mirror row into email_actions
   * alongside the real proposal in calendar_actions — and, until the
   * matching fix in app/dashboard/approvals/actions.ts, nothing ever
   * updated that mirror row once the real proposal was approved or
   * dismissed. The result: this count included permanently-orphaned
   * mirror rows that the approvals page (which only ever shows
   * action_type "draft_reply" email actions, plus calendar_actions
   * directly — see app/dashboard/approvals/page.tsx) would never
   * display, so the dashboard could say "N waiting" while the approvals
   * page showed nothing to review at all.
   *
   * Fix: count exactly what the approvals page actually shows — pending
   * draft replies AND pending calendar/Zoom proposals — instead of "any
   * pending_approval row regardless of type." This can't drift out of
   * sync with what's actually reviewable even if something else mirrors
   * a status elsewhere in the future, since it no longer trusts an
   * unfiltered status count as a proxy for "actionable items."
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

  const pending = (pendingDraftCount ?? 0) + (pendingEventCount ?? 0);

  return (
    <Page width="full">
      <PageHeader
        eyebrow="Overview"
        title={tenant?.business_name ?? "Your business"}
        description={
          tenant?.business_description ??
          "Your agent's workspace — review what's waiting, then tune how it works."
        }
      />

      <Bento>
        <BentoItem span="md">
          <Panel padding="lg" tone={pending > 0 ? "accent" : "surface"} className="flex flex-col justify-between gap-8">
            <Stat
              label="Waiting for your review"
              value={pending}
              hint={pending === 1 ? "1 draft needs a decision" : `${pending} drafts need a decision`}
            />

            <Link
              href="/dashboard/approvals"
              className="focus-ring inline-flex w-fit items-center gap-2 rounded-control text-sm font-semibold text-accent-ink hover:underline"
            >
              Open approvals →
            </Link>
          </Panel>
        </BentoItem>

        <BentoItem span="md">
          <Panel padding="lg" className="flex h-full flex-col justify-between gap-8">
            <div>
              <PanelTitle hint={<Badge tone="success">Live</Badge>}>Agent status</PanelTitle>
              <p className="text-sm leading-relaxed text-muted">
                The agent only acts inside the permissions you set. Anything gated is drafted and
                sent to approvals instead of going out.
              </p>
            </div>

            <Link
              href="/dashboard/agent"
              className="focus-ring inline-flex w-fit items-center gap-2 rounded-control text-sm font-semibold text-accent-ink hover:underline"
            >
              Review permissions →
            </Link>
          </Panel>
        </BentoItem>

        {SHORTCUTS.map((shortcut) => (
          <BentoItem key={shortcut.href} span="md">
            <Link href={shortcut.href} className="focus-ring block h-full rounded-panel">
              <Panel className="h-full transition-shadow hover:shadow-pop">
                <PanelTitle>{shortcut.title}</PanelTitle>
                <p className="text-sm leading-relaxed text-muted">{shortcut.text}</p>
              </Panel>
            </Link>
          </BentoItem>
        ))}
      </Bento>
    </Page>
  );
}