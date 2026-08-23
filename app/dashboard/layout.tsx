import { createServerSupabase } from "@/lib/supabase/server";
import UserMenu from "./components/UserMenu";

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
    <>
      <UserMenu
        name={name}
        email={email}
        avatarUrl={avatarUrl}
      />

      {children}
    </>
  );
}