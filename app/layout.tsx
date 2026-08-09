import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Email Agent",
  description: "An AI agent that handles your business email, on your terms.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
