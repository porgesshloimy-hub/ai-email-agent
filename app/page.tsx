"use client";

import { createClient } from "@/lib/supabase/client";

export default function LandingPage() {
  const handleGoogleLogin = async () => {
    const supabase = createClient();

    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
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
            fontSize: 13,
            color: "#6b7280",
            fontWeight: 500,
          }}
        >
          AI-powered email management
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

        {/* Google Sign-In */}
        <div style={{ marginTop: 42 }}>
          <button
            onClick={handleGoogleLogin}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              height: 54,
              padding: "0 25px",
              background: "#ffffff",
              color: "#1f2937",
              border: "1px solid #d9dce3",
              borderRadius: 12,
              fontSize: 15,
              fontWeight: 650,
              cursor: "pointer",
              boxShadow:
                "0 1px 2px rgba(0,0,0,0.04), 0 6px 20px rgba(0,0,0,0.06)",
            }}
          >
            {/* Google Logo */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fill="#4285F4"
                d="M21.35 12.27c0-.79-.07-1.55-.2-2.27H12v4.3h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.14c1.84-1.69 2.91-4.18 2.91-7.42z"
              />

              <path
                fill="#34A853"
                d="M12 21.7c2.63 0 4.84-.87 6.45-2.35l-3.14-2.45c-.87.58-1.98.92-3.31.92-2.54 0-4.69-1.72-5.46-4.03H3.3v2.53A9.74 9.74 0 0 0 12 21.7z"
              />

              <path
                fill="#FBBC05"
                d="M6.54 13.79A5.85 5.85 0 0 1 6.23 12c0-.62.11-1.23.31-1.79V7.68H3.3A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.05 1.05 4.32l3.24-2.53z"
              />

              <path
                fill="#EA4335"
                d="M12 6.18c1.43 0 2.72.49 3.74 1.45l2.8-2.8C16.84 3.27 14.63 2.3 12 2.3a9.74 9.74 0 0 0-8.7 5.38l3.24 2.53C7.31 7.9 9.46 6.18 12 6.18z"
              />
            </svg>

            Continue with Google
          </button>

          <div
            style={{
              marginTop: 14,
              fontSize: 12,
              color: "#9ca3af",
            }}
          >
            Securely sign in with your Google account
          </div>
        </div>
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