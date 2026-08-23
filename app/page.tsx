"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import UserMenu from "@/app/dashboard/components/UserMenu";

export default function LandingPage() {
  const [user, setUser] = useState<any>(null);
const [loading, setLoading] = useState(true);

useEffect(() => {
  const supabase = createClient();

  async function loadUser() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    setUser(user);
    setLoading(false);
  }

  loadUser();

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(
    (_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    }
  );

  return () => {
    subscription.unsubscribe();
  };
}, []);

  const handleGoogleLogin = async () => {
    const supabase = createClient();

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      console.error("Google sign-in error:", error);
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at 50% -10%, #eef2ff 0%, #ffffff 42%)",
        color: "#111827",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      }}
    >
      {/* Header */}
      <header
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: "28px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            fontSize: 21,
            fontWeight: 750,
            letterSpacing: "-0.04em",
          }}
        >
          Prime<span style={{ color: "#635bff" }}>Automatic</span>
        </div>

        <div
  style={{
    display: "flex",
    alignItems: "center",
    gap: 18,
  }}
>
  <div
    style={{
      fontSize: 13,
      color: "#6b7280",
      fontWeight: 500,
    }}
  >
    AI-powered email management
  </div>

  {!loading && !user && (
    <button
      type="button"
      onClick={handleGoogleLogin}
      style={{
        height: 38,
        padding: "0 16px",
        borderRadius: 9,
        border: "1px solid #d9dce3",
        background: "#ffffff",
        color: "#1f2937",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      }}
    >
      Sign in
    </button>
  )}

  {!loading && user && (
    <UserMenu
      name={
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        "Account"
      }
      email={user.email || ""}
      avatarUrl={
        user.user_metadata?.avatar_url ||
        user.user_metadata?.picture ||
        null
      }
    />
  )}
</div>
      </header>

      {/* Hero */}
      <section
        style={{
          maxWidth: 900,
          margin: "0 auto",
          padding: "105px 28px 80px",
          textAlign: "center",
        }}
      >
        {/* Badge */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 13px",
            borderRadius: 999,
            background: "rgba(99, 91, 255, 0.08)",
            border: "1px solid rgba(99, 91, 255, 0.12)",
            color: "#635bff",
            fontSize: 13,
            fontWeight: 650,
            marginBottom: 26,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#635bff",
            }}
          />
          Your inbox, on autopilot.
        </div>

        {/* Headline */}
        <h1
          style={{
            fontSize: "clamp(48px, 7vw, 78px)",
            lineHeight: 1.02,
            letterSpacing: "-0.065em",
            margin: "0 auto",
            maxWidth: 850,
            fontWeight: 750,
          }}
        >
          Your inbox,
          <br />
          <span style={{ color: "#635bff" }}>handled.</span>
        </h1>

        {/* Description */}
        <p
          style={{
            maxWidth: 650,
            margin: "28px auto 0",
            fontSize: 19,
            lineHeight: 1.65,
            color: "#6b7280",
            letterSpacing: "-0.01em",
          }}
        >
          Connect Gmail and give your AI agent the context it needs to run
          your inbox. Decide exactly what it can handle automatically — and
          what requires your approval.
        </p>

      </section>

      {/* Feature Cards */}
      <section
        style={{
          maxWidth: 1050,
          margin: "0 auto",
          padding: "20px 28px 100px",
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 16,
        }}
      >
        {[
          {
            number: "01",
            title: "Understand",
            text: "Your agent learns your business, your customers, and how you want emails handled.",
          },
          {
            number: "02",
            title: "Automate",
            text: "Let AI handle routine emails and take action on the work you don't want to do yourself.",
          },
          {
            number: "03",
            title: "Stay in control",
            text: "Set approval rules so important decisions always come back to you first.",
          },
        ].map((feature) => (
          <div
            key={feature.number}
            style={{
              padding: "28px",
              background: "rgba(255,255,255,0.75)",
              border: "1px solid #e8eaf0",
              borderRadius: 18,
              boxShadow: "0 4px 20px rgba(0,0,0,0.025)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "#635bff",
                marginBottom: 24,
                letterSpacing: "0.08em",
              }}
            >
              {feature.number}
            </div>

            <h3
              style={{
                margin: "0 0 9px",
                fontSize: 18,
                letterSpacing: "-0.025em",
              }}
            >
              {feature.title}
            </h3>

            <p
              style={{
                margin: 0,
                fontSize: 14,
                lineHeight: 1.6,
                color: "#6b7280",
              }}
            >
              {feature.text}
            </p>
          </div>
        ))}
      </section>

      {/* Footer */}
      <footer
        style={{
          borderTop: "1px solid #eef0f4",
          padding: "25px 28px",
          textAlign: "center",
          color: "#9ca3af",
          fontSize: 12,
        }}
      >
        PrimeAutomatic · Intelligent email, without giving up control.
      </footer>
    </main>
  );
}