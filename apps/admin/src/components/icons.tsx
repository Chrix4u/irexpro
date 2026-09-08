/**
 * Professional SVG icon set for the iRexPro admin app — Sprint 31 remediation.
 *
 * Mirrors apps/web/src/components/icons.tsx. Replaces emoji icons in the admin
 * mobile bottom navigation and "More" sheet with deterministic, cross-platform
 * SVG icons (Lucide-style outline, currentColor, 24×24 viewBox).
 *
 * See apps/web/src/components/icons.tsx for the full design rationale
 * (emoji rendering inconsistency, zero new dependencies, decorative icons
 * with text-based accessible names).
 */
import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'aria-hidden'> {
  size?: number;
}

function Svg({ size = 24, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

// ── Primary navigation icons ────────────────────────────────────────────────

/** Dashboard — four-quadrant grid. */
export function DashboardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Svg>
  );
}

/** Users — two people. */
export function UsersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14.2c2.8.3 5 2.1 5 4.8" />
    </Svg>
  );
}

/** Brokers — plug/connection. */
export function PlugIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M7 8h10v3a5 5 0 0 1-10 0V8z" />
      <path d="M12 16v6" />
    </Svg>
  );
}

/** Payments — credit card. */
export function PaymentsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M2 9.5h20" />
      <path d="M6 15h4" />
    </Svg>
  );
}

/** More — three horizontal dots. */
export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

// ── Secondary (More sheet) icons ─────────────────────────────────────────────

/** Subscriptions — clipboard with list. */
export function SubscriptionsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />
      <path d="M9 11h6" />
      <path d="M9 15h6" />
    </Svg>
  );
}

/** Audit log — document with lines. */
export function AuditIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 3h7l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </Svg>
  );
}

/** Live Ops — heartbeat / activity pulse (Sprint 50 live operations). */
export function PulseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 12h4l2.5-7 4 14 2.5-7h3.5" />
      <path d="M20.5 12h1.5" />
    </Svg>
  );
}

/** Log out — door + arrow. */
export function LogoutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M9 12h11" />
      <path d="M16 8l4 4-4 4" />
    </Svg>
  );
}

/** Close — X. */
export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  );
}
