"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createBrowserClient } from "@supabase/ssr";

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
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: 20,
        right: 20,
        zIndex: 1000,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Open account menu"
        aria-expanded={open}
        style={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          border: "1px solid #ddd",
          padding: 0,
          overflow: "hidden",
          cursor: "pointer",
          background: "#f1f1f1",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={name || "Account"}
            width={40}
            height={40}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          initials
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 48,
            right: 0,
            width: 240,
            background: "#fff",
            border: "1px solid #ddd",
            borderRadius: 12,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            padding: 8,
          }}
        >
          <div
            style={{
              padding: "10px 12px 12px",
              borderBottom: "1px solid #eee",
              marginBottom: 6,
            }}
          >
            <div
              style={{
                fontWeight: 600,
                fontSize: 14,
                marginBottom: 3,
              }}
            >
              {name}
            </div>

            <div
              style={{
                fontSize: 12,
                color: "#666",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {email}
            </div>
          </div>

          <Link
            href="/dashboard/settings"
            onClick={() => setOpen(false)}
            style={{
              display: "block",
              padding: "9px 12px",
              borderRadius: 8,
              color: "#222",
              textDecoration: "none",
              fontSize: 14,
            }}
          >
            Settings
          </Link>

          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "9px 12px",
              border: 0,
              borderRadius: 8,
              background: "transparent",
              color: "#222",
              fontSize: 14,
              cursor: signingOut ? "default" : "pointer",
            }}
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}