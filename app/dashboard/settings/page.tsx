import { createServerSupabase } from "@/lib/supabase/server";
import { INTEGRATIONS } from "@/lib/integrations/config";
import { disconnectGoogle, disconnectZoom } from "./actions";
import {
  Badge,
  Bento,
  BentoItem,
  Button,
  ButtonLink,
  Input,
  Label,
  Page,
  PageHeader,
  Panel,
  PanelTitle,
  SectionHeading,
} from "@/components/ui";

const DISCONNECT_ACTIONS: Record<string, () => Promise<void>> = {
  google: disconnectGoogle,
  zoom: disconnectZoom,
};

export default async function SettingsPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("owner_user_id", user?.id)
    .single();

  const [{ data: gmailConnection }, { data: zoomConnection }] = await Promise.all([
    supabase
      .from("gmail_connections")
      .select("gmail_address, connected_at, google_reauth_required")
      .eq("tenant_id", tenant?.id)
      .single(),
    supabase
      .from("zoom_connections")
      .select("zoom_email, connected_at, token_expiry")
      .eq("tenant_id", tenant?.id)
      .single(),
  ]);

  const zoomExpired = zoomConnection?.token_expiry
    ? new Date(zoomConnection.token_expiry).getTime() < Date.now()
    : false;

  /**
   * BUG FIX: this previously never selected google_reauth_required at
   * all, so even once lib/gmail/client.ts correctly marks a dead Google
   * grant (see getGmailClient's invalid_grant handling), this page had
   * no way to know and would keep showing Google as plainly "Connected"
   * indefinitely — the only integration on this page that could
   * silently be broken with no visible prompt to reconnect.
   */
  const connectionStatus: Record<string, { label: string; expired?: boolean } | null> = {
    google: gmailConnection
      ? {
          label: gmailConnection.gmail_address,
          expired: Boolean((gmailConnection as any).google_reauth_required),
        }
      : null,
    zoom: zoomConnection ? { label: zoomConnection.zoom_email, expired: zoomExpired } : null,
  };

  return (
    <Page width="full">
      <PageHeader
        eyebrow="Settings"
        title="Business & connections"
        description="Manage the accounts and services connected to your workspace."
      />

      <section className="mb-12">
        <SectionHeading
          title="Connections"
          description="The agent can only reach services you've connected here."
        />

        <Panel padding="none" className="overflow-hidden">
          {INTEGRATIONS.map((integration, index) => {
            const status = connectionStatus[integration.id];
            const isConnected = Boolean(status) && !status?.expired;
            const needsReconnect = Boolean(status?.expired);
            const Icon = integration.icon;
            const disconnectAction = DISCONNECT_ACTIONS[integration.id];

            const badgeTone = isConnected ? "success" : needsReconnect ? "warning" : "neutral";
            const badgeText = isConnected
              ? "Connected"
              : needsReconnect
                ? "Needs reconnect"
                : "Not connected";

            return (
              <div
                key={integration.id}
                className={`flex flex-wrap items-center gap-4 p-5 ${
                  index === 0 ? "" : "border-t border-line"
                }`}
              >
                <Icon size={36} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-[15px] font-semibold text-ink">
                      {integration.name}
                    </span>
                    <Badge tone={badgeTone}>{badgeText}</Badge>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted">
                    {status ? status.label : integration.description}
                  </p>
                </div>

                {needsReconnect ? (
                  <ButtonLink href={integration.connectHref} variant="warning" size="sm">
                    Reconnect
                  </ButtonLink>
                ) : isConnected ? (
                  <form action={disconnectAction}>
                    <Button type="submit" variant="danger" size="sm">
                      Disconnect
                    </Button>
                  </form>
                ) : (
                  <ButtonLink href={integration.connectHref} size="sm">
                    Connect
                  </ButtonLink>
                )}
              </div>
            );
          })}
        </Panel>
      </section>

      <Bento>
        <BentoItem span="md">
          <Panel padding="lg">
            <PanelTitle>Google Chat</PanelTitle>
            <p className="text-sm leading-relaxed text-muted">
              Message the agent directly by finding &quot;{process.env.NEXT_PUBLIC_APP_NAME ?? "your app"}
              &quot; in Google Chat and starting a DM. It recognizes you automatically if you chat
              from {connectionStatus.google?.label ?? "your connected Gmail address"}.
            </p>

            <div className="mt-5">
              <Label>Chatting from a different Google account? Enter it here</Label>
              <Input
                type="email"
                defaultValue={tenant?.owner_google_email ?? ""}
                placeholder="you@gmail.com"
              />
            </div>
          </Panel>
        </BentoItem>

        <BentoItem span="md">
          <Panel padding="lg">
            <PanelTitle>Business information</PanelTitle>

            <dl className="divide-y divide-line text-sm">
              <div className="flex items-baseline justify-between gap-6 py-3">
                <dt className="text-muted">Business name</dt>
                <dd className="text-right font-medium text-ink">
                  {tenant?.business_name ?? "—"}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-6 py-3">
                <dt className="shrink-0 text-muted">Description</dt>
                <dd className="text-right leading-relaxed text-ink-2">
                  {tenant?.business_description ?? "—"}
                </dd>
              </div>
            </dl>
          </Panel>
        </BentoItem>
      </Bento>
    </Page>
  );
}
