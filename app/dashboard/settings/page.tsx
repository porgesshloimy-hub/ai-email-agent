import { createServerSupabase } from "@/lib/supabase/server";
import { INTEGRATIONS } from "@/lib/integrations/config";
import { disconnectGoogle, disconnectZoom } from "./actions";

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
      .select("gmail_address, connected_at")
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

  const connectionStatus: Record<string, { label: string; expired?: boolean } | null> = {
    google: gmailConnection ? { label: gmailConnection.gmail_address } : null,
    zoom: zoomConnection ? { label: zoomConnection.zoom_email, expired: zoomExpired } : null,
  };

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1 style={{ marginBottom: 4 }}>Business & connections</h1>
      <p style={{ fontSize: 14, color: "#6b7280", marginTop: 0, marginBottom: 32 }}>
        Manage the accounts and services connected to your workspace.
      </p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ marginBottom: 16 }}>Connections</h2>
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            overflow: "hidden",
            background: "#fff",
          }}
        >
          {INTEGRATIONS.map((integration, index) => {
            const status = connectionStatus[integration.id];
            const isConnected = Boolean(status) && !status?.expired;
            const needsReconnect = Boolean(status?.expired);
            const Icon = integration.icon;
            const disconnectAction = DISCONNECT_ACTIONS[integration.id];

            let badgeBg = "#f3f4f6";
            let badgeColor = "#6b7280";
            let badgeText = "Not connected";
            if (isConnected) {
              badgeBg = "#ecfdf5";
              badgeColor = "#047857";
              badgeText = "Connected";
            } else if (needsReconnect) {
              badgeBg = "#fffbeb";
              badgeColor = "#b45309";
              badgeText = "Needs reconnect";
            }

            return (
              <div
                key={integration.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: 16,
                  borderTop: index === 0 ? "none" : "1px solid #e5e7eb",
                }}
              >
                <Icon size={36} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{integration.name}</span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: badgeBg,
                        color: badgeColor,
                      }}
                    >
                      {badgeText}
                    </span>
                  </div>
                  <p
                    style={{
                      fontSize: 14,
                      color: "#6b7280",
                      margin: "2px 0 0",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {status ? status.label : integration.description}
                  </p>
                </div>

                {needsReconnect ? (
                  <a href={integration.connectHref}>
                    <button
                      type="button"
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: "#fff",
                        background: "#b45309",
                        border: "none",
                        padding: "8px 14px",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      Reconnect
                    </button>
                  </a>
                ) : isConnected ? (
                  <form action={disconnectAction}>
                    <button
                      type="submit"
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: "#dc2626",
                        background: "none",
                        border: "none",
                        padding: "6px 12px",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      Disconnect
                    </button>
                  </form>
                ) : (
                  <a href={integration.connectHref}>
                    <button
                      type="button"
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: "#fff",
                        background: "#111827",
                        border: "none",
                        padding: "8px 14px",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      Connect
                    </button>
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2>Google Chat</h2>
        <p style={{ fontSize: 14 }}>
          Message the agent directly by finding "{process.env.NEXT_PUBLIC_APP_NAME ?? "your app"}" in Google Chat and
          starting a DM. It recognizes you automatically if you chat from{" "}
          {connectionStatus.google?.label ?? "your connected Gmail address"}.
        </p>
        <label style={{ fontSize: 13, display: "block", marginBottom: 4 }}>
          Chatting from a different Google account? Enter it here:
        </label>
        <input type="email" defaultValue={tenant?.owner_google_email ?? ""} placeholder="you@gmail.com" />
      </section>

      <section>
        <h2>Business information</h2>
        <p>Business name: {tenant?.business_name ?? "—"}</p>
        <p>Description: {tenant?.business_description ?? "—"}</p>
      </section>
    </main>
  );
}