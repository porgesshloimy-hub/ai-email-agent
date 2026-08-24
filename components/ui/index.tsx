/**
 * Shared presentational primitives — PrimeAutomatic design system.
 * Purely visual: no data fetching, no app logic. Screens compose these.
 */

import Link from "next/link";
import type { ReactNode } from "react";

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/* ----------------------------------------------------------------- Page */

export function Page({
  children,
  width = "wide",
  className,
}: {
  children: ReactNode;
  width?: "narrow" | "wide" | "full";
  className?: string;
}) {
  const max =
    width === "narrow" ? "max-w-3xl" : width === "full" ? "max-w-[1240px]" : "max-w-5xl";

  return (
    <main className={cx("mx-auto w-full px-6 pb-24 pt-12 sm:px-8", max, className)}>
      {children}
    </main>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-10 flex flex-wrap items-end justify-between gap-6">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-3 font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
            {eyebrow}
          </div>
        )}
        <h1 className="text-3xl leading-tight text-ink sm:text-[40px]">{title}</h1>
        {description && (
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SectionHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg text-ink">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/* ------------------------------------------------------------ Bento grid */

export function Bento({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6", className)}>
      {children}
    </div>
  );
}

const SPANS: Record<string, string> = {
  sm: "lg:col-span-2",
  md: "lg:col-span-3",
  lg: "lg:col-span-4",
  full: "sm:col-span-2 lg:col-span-6",
};

export function BentoItem({
  span = "sm",
  children,
  className,
}: {
  span?: keyof typeof SPANS;
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx(SPANS[span], className)}>{children}</div>;
}

/* ---------------------------------------------------------------- Panel */

export function Panel({
  children,
  className,
  padding = "md",
  tone = "surface",
}: {
  children: ReactNode;
  className?: string;
  padding?: "none" | "sm" | "md" | "lg";
  tone?: "surface" | "quiet" | "accent";
}) {
  const pad =
    padding === "none" ? "" : padding === "sm" ? "p-4" : padding === "lg" ? "p-7" : "p-6";

  const tones = {
    surface: "bg-surface border-line",
    quiet: "bg-surface-2 border-line",
    accent: "bg-accent-soft border-accent/15",
  } as const;

  return (
    <section
      className={cx(
        "h-full rounded-panel border shadow-panel",
        tones[tone],
        pad,
        className,
      )}
    >
      {children}
    </section>
  );
}

export function PanelTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h3 className="font-display text-[15px] font-semibold text-ink">{children}</h3>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className="mt-2 font-display text-[34px] leading-none text-ink">{value}</div>
      {hint && <div className="mt-2 text-sm text-muted">{hint}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- Button */

const BUTTON_BASE =
  "focus-ring inline-flex items-center justify-center gap-2 rounded-control text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-60";

const BUTTON_SIZES = {
  sm: "h-9 px-3",
  md: "h-10 px-4",
  lg: "h-11 px-5 text-[15px]",
} as const;

const BUTTON_VARIANTS = {
  primary: "bg-accent text-white hover:bg-accent-ink",
  secondary: "border border-line-strong bg-surface text-ink-2 hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2",
  danger: "text-danger hover:bg-danger-soft",
  warning: "bg-warning text-white hover:brightness-95",
} as const;

type ButtonLook = {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonLook & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}
    />
  );
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  href,
  children,
  ...props
}: ButtonLook & { href: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={href}
      {...props}
      className={cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}
    >
      {children}
    </a>
  );
}

export function NavLink({
  href,
  children,
  active,
}: {
  href: string;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cx(
        "focus-ring rounded-control px-3 py-2 text-sm font-medium transition-colors",
        active ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-surface-2",
      )}
    >
      {children}
    </Link>
  );
}

/* ---------------------------------------------------------------- Badge */

const BADGE_TONES = {
  neutral: "bg-surface-2 text-muted",
  accent: "bg-accent-soft text-accent-ink",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
} as const;

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- Input */

const FIELD =
  "focus-ring w-full rounded-control border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD, className)} />;
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(FIELD, "resize-y leading-relaxed", className)} />;
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-ink-2">
      {children}
    </label>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Panel tone="quiet" padding="lg" className="text-center">
      <h3 className="text-base text-ink">{title}</h3>
      {description && <p className="mx-auto mt-2 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </Panel>
  );
}
