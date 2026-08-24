"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createBrowserClient } from "@supabase/ssr";
import { Settings, LogOut } from "lucide-react";

type UserMenuProps = {
  name: string;
  email: string;
  avatarUrl?: string | null;
};

export default function UserMenu({
  name,
  email,
  avatarUrl,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  async function handleSignOut() {
    setSigningOut(true);

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    await supabase.auth.signOut();

    window.location.href = "/";
  }

  const initials =
    name
      ?.split(" ")
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";

  return (
    <div ref={menuRef} className="relative">
      {/* Avatar button */}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Open account menu"
        aria-expanded={open}
        className={`focus-ring flex size-10 items-center justify-center overflow-hidden rounded-full border-2 bg-surface-2 font-display text-[13px] font-semibold text-ink-2 transition-colors ${
          open ? "border-accent" : "border-line-strong hover:border-muted"
        }`}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={name || "Account"}
            width={40}
            height={40}
            className="size-full object-cover"
          />
        ) : (
          initials
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-12 w-64 overflow-hidden rounded-panel border border-line bg-surface p-2 shadow-pop">
          {/* User information */}
          <div className="mb-1 flex items-center gap-3 p-2.5 pb-3">
            <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 text-xs font-semibold text-ink-2">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  width={36}
                  height={36}
                  className="size-full object-cover"
                />
              ) : (
                initials
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-ink">{name}</div>
              <div className="truncate text-xs text-muted">{email}</div>
            </div>
          </div>

          {/* Divider */}
          <div className="mx-1 mb-1.5 h-px bg-line" />

          {/* Settings */}
          <Link
            href="/dashboard/settings"
            onClick={() => setOpen(false)}
            className="focus-ring flex items-center gap-2.5 rounded-control px-3 py-2.5 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-2"
          >
            <Settings size={16} strokeWidth={2} />
            Settings
          </Link>

          {/* Sign out */}
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="focus-ring flex w-full items-center gap-2.5 rounded-control px-3 py-2.5 text-left text-sm font-medium text-muted transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted"
          >
            <LogOut size={16} strokeWidth={2} />
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
