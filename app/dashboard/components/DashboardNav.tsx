"use client";

import { usePathname } from "next/navigation";
import { NavLink } from "@/components/ui";

const LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/approvals", label: "Approvals" },
  { href: "/dashboard/agent", label: "Agent" },
  { href: "/dashboard/settings", label: "Connections" },
  { href: "/dashboard/settings/knowledge", label: "Knowledge" },
  { href: "/dashboard/billing", label: "Usage & billing" },
];

export default function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1">
      {LINKS.map((link) => (
        <span key={link.href} className="shrink-0">
          <NavLink
            href={link.href}
            active={
              link.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname === link.href || pathname.startsWith(`${link.href}/`)
            }
          >
            {link.label}
          </NavLink>
        </span>
      ))}
    </nav>
  );
}
