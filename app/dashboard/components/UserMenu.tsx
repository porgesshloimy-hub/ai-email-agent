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
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: 18,
        right: 20,
        zIndex: 1000,
      }}
    >
      {/* Avatar button */}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Open account menu"
        aria-expanded={open}
        style={{
          width: 42,
          height: 42,
          borderRadius: "50%",
          border: open ? "2px solid #111827" : "2px solid #ffffff",
          padding: 0,
          overflow: "hidden",
          cursor: "pointer",
          background: "#f3f4f6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 600,
          fontSize: 13,
          boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
          transition: "all 0.15s ease",
        }}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={name || "Account"}
            width={42}
            height={42}
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

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: 52,
            right: 0,
            width: 260,
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            boxShadow:
              "0 12px 35px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.05)",
            padding: 8,
            overflow: "hidden",
          }}
        >
          {/* User information */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              padding: "10px 10px 12px",
              marginBottom: 4,
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: "50%",
                overflow: "hidden",
                background: "#f3f4f6",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  width={38}
                  height={38}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                initials
              )}
            </div>

            <div
              style={{
                minWidth: 0,
                flex: 1,
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  color: "#111827",
                  marginBottom: 3,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {name}
              </div>

              <div
                style={{
                  fontSize: 12,
                  color: "#6b7280",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {email}
              </div>
            </div>
          </div>

          {/* Divider */}
          <div
            style={{
              height: 1,
              background: "#f0f0f0",
              margin: "2px 4px 6px",
            }}
          />

          {/* Settings */}
          <Link
            href="/dashboard/settings"
            onClick={() => setOpen(false)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 11px",
              borderRadius: 9,
              color: "#374151",
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 500,
              transition: "background 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#f5f5f5";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <Settings size={16} strokeWidth={2} />
            Settings
          </Link>

          {/* Sign out */}
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              textAlign: "left",
              padding: "10px 11px",
              border: 0,
              borderRadius: 9,
              background: "transparent",
              color: "#6b7280",
              fontSize: 14,
              fontWeight: 500,
              cursor: signingOut ? "default" : "pointer",
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              if (!signingOut) {
                e.currentTarget.style.background = "#fef2f2";
                e.currentTarget.style.color = "#dc2626";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "#6b7280";
            }}
          >
            <LogOut size={16} strokeWidth={2} />
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}