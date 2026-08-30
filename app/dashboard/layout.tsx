import { createServerSupabase } from "@/lib/supabase/server";
import UserMenu from "./components/UserMenu";
import DashboardNav from "./components/DashboardNav";
import AgentChatWidget from "./components/AgentChatWidget";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const name =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    "Account";

  const email = user?.email || "";

  const avatarUrl =
    user?.user_metadata?.avatar_url ||
    user?.user_metadata?.picture ||
    null;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-50 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1240px] items-center gap-4 px-6 py-3 sm:px-8">
          <a
            href="/dashboard"
            className="focus-ring shrink-0 rounded-control font-display text-[17px] font-bold tracking-[-0.04em] text-ink"
          >
            Prime<span className="text-accent">Automatic</span>
          </a>

          <DashboardNav />

          <div className="ml-auto shrink-0">
            <UserMenu
              name={name}
              email={email}
              avatarUrl={avatarUrl}
            />
          </div>
        </div>
      </header>

      {children}

      <AgentChatWidget />
    </div>
  );
}
