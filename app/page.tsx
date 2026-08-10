import Link from "next/link";

export default function LandingPage() {
  return (
    <main style={{ maxWidth: 640, margin: "80px auto", fontFamily: "system-ui" }}>
      <h1>Your inbox, handled.</h1>
      <p>
        Connect Gmail, tell your agent about your business, and decide exactly what it's allowed to do on its own —
        and what needs your sign-off first.
      </p>
      <Link href="/api/auth/gmail">
        <button style={{ padding: "10px 20px", fontSize: 16 }}>Get started</button>
      </Link>
    </main>
  );
}
