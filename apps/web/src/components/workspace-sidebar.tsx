"use client";

import { useState, type ComponentType } from "react";
import Link from "next/link";
import {
  DashboardIcon,
  LogoutIcon,
  PaymentsIcon,
  PlugIcon,
  PortfolioIcon,
  ShieldIcon,
  TradeIcon,
  UserIcon,
  type IconProps,
} from "@/components/icons";

interface WorkspaceNavItem {
  href: string;
  label: string;
  Icon: ComponentType<IconProps>;
  matchPrefix?: boolean;
}

interface WorkspaceNavGroup {
  label: string;
  items: WorkspaceNavItem[];
}

const WORKSPACE_NAV: WorkspaceNavGroup[] = [
  {
    label: "Trading",
    items: [
      { href: "/dashboard", label: "Dashboard", Icon: DashboardIcon },
      { href: "/trade", label: "AI Trading", Icon: TradeIcon },
      { href: "/trade/portfolio", label: "Portfolio", Icon: PortfolioIcon },
      { href: "/portfolio", label: "Portfolio & Risk", Icon: ShieldIcon },
      {
        href: "/live-account",
        label: "Positions & Activity",
        Icon: PortfolioIcon,
        matchPrefix: true,
      },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/profile", label: "My Profile", Icon: UserIcon },
      { href: "/onboarding/broker", label: "Broker Account", Icon: PlugIcon },
      { href: "/security", label: "Security", Icon: ShieldIcon },
      {
        href: "/payments/success",
        label: "Fees & Payments",
        Icon: PaymentsIcon,
        matchPrefix: true,
      },
    ],
  },
];

function navItemActive(
  activeRoute: string | undefined,
  item: WorkspaceNavItem,
): boolean {
  if (!activeRoute) return false;
  if (item.matchPrefix) {
    return activeRoute === item.href || activeRoute.startsWith(`${item.href}/`);
  }
  return activeRoute === item.href;
}

export function workspaceRouteTitle(activeRoute: string | undefined): string {
  for (const group of WORKSPACE_NAV) {
    for (const item of group.items) {
      if (navItemActive(activeRoute, item)) return item.label;
    }
  }
  return "Dashboard";
}

interface WorkspaceSidebarProps {
  user: {
    email: string | null;
    firstName?: string | null;
    lastName?: string | null;
    roles?: string[];
  } | null;
  onLogout: () => void;
  activeRoute?: string;
}

export default function WorkspaceSidebar({
  user,
  onLogout,
  activeRoute,
}: WorkspaceSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const userLabel = user
    ? user.firstName || user.lastName
      ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim()
      : user.email
    : null;
  const isAdmin =
    user?.roles?.some((role) => role === "ADMIN" || role === "SUPER_ADMIN") ??
    false;
  const navGroups: WorkspaceNavGroup[] = isAdmin
    ? [
        ...WORKSPACE_NAV,
        {
          label: "Administration",
          items: [
            {
              href: "/admin/performance-fees",
              label: "Performance Fees",
              Icon: PaymentsIcon,
              matchPrefix: true,
            },
          ],
        },
      ]
    : WORKSPACE_NAV;

  return (
    <aside
      className={`dashboard-sidebar terminal-sidebar${collapsed ? " terminal-sidebar--collapsed" : ""}`}
      data-sidebar-collapsed={collapsed ? "true" : "false"}
    >
      <div className="terminal-sidebar__top">
        <Link
          href="/dashboard"
          className="dashboard-sidebar__logo terminal-sidebar__brand"
          aria-label="iRexPro dashboard"
          title={collapsed ? "iRexPro dashboard" : undefined}
        >
          <span className="auth-layout__logo-mark terminal-sidebar__logo-mark">
            iR
          </span>
          <span className="terminal-sidebar__brand-copy">
            <span className="terminal-sidebar__brand-name">iRexPro</span>
            <span className="terminal-sidebar__brand-subtitle">AI Trading</span>
          </span>
        </Link>

        <button
          type="button"
          className="terminal-sidebar__collapse"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls="workspace-primary-navigation"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
        </button>
      </div>

      <nav
        id="workspace-primary-navigation"
        className="dashboard-sidebar__nav terminal-nav"
        aria-label="Primary workspace navigation"
      >
        {navGroups.map((group) => (
          <div className="terminal-nav__group" key={group.label}>
            <div className="terminal-nav__group-label">{group.label}</div>
            {group.items.map((item) => {
              const { Icon } = item;
              const active = navItemActive(activeRoute, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active ? "active" : ""}
                  aria-current={active ? "page" : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  title={collapsed ? item.label : undefined}
                >
                  <span className="terminal-nav__icon" aria-hidden="true">
                    <Icon size={18} />
                  </span>
                  <span className="terminal-nav__label">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {user && (
        <div className="dashboard-sidebar__user terminal-sidebar__user">
          <span className="terminal-sidebar__user-label">Signed in</span>
          <p className="terminal-sidebar__user-name text-sm">{userLabel}</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--block terminal-sidebar__logout"
            aria-label={collapsed ? "Log out" : undefined}
            title={collapsed ? "Log out" : undefined}
            onClick={onLogout}
          >
            <span className="terminal-sidebar__logout-icon" aria-hidden="true">
              <LogoutIcon size={17} />
            </span>
            <span className="terminal-sidebar__logout-label">Log out</span>
          </button>
        </div>
      )}
    </aside>
  );
}