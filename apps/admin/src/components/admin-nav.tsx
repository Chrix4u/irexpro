'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { Button } from '@/components/ui';
import type { ComponentType } from 'react';
import type { IconProps } from '@/components/icons';
import {
  DashboardIcon,
  UsersIcon,
  PaymentsIcon,
  PlugIcon,
  AuditIcon,
  PulseIcon,
} from '@/components/icons';

/**
 * Admin desktop sidebar navigation items.
 *
 * The backend RolesGuard is the real security boundary. This visual hiding is
 * a UX concern, not a security control.
 */
const NAV: Array<{ href: string; label: string; Icon: ComponentType<IconProps> }> = [
  { href: '/admin/dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { href: '/admin/users', label: 'Users', Icon: UsersIcon },
  { href: '/admin/account-appeals', label: 'Account Reviews', Icon: UsersIcon },
  { href: '/admin/eligibility-reviews', label: 'Eligibility Reviews', Icon: AuditIcon },
  { href: '/admin/kyc-reviews', label: 'KYC Reviews', Icon: UsersIcon },
  { href: '/admin/payments', label: 'Payments', Icon: PaymentsIcon },
  { href: '/admin/brokers', label: 'Brokers', Icon: PlugIcon },
  { href: '/admin/live-ops', label: 'Live Ops', Icon: PulseIcon },
  { href: '/admin/audit', label: 'Audit Log', Icon: AuditIcon },
];

export default function AdminNav() {
  const pathname = usePathname();
  const { hasAdminRole } = useAuth();

  if (!hasAdminRole) return null;

  return (
    <nav aria-label="Admin navigation">
      {NAV.map((item) => {
        const { Icon } = item;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={pathname === item.href ? 'active' : ''}
            aria-current={pathname === item.href ? 'page' : undefined}
          >
            <span aria-hidden="true">
              <Icon size={18} />
            </span>{' '}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AdminSidebarUser() {
  const { user, logout, loading, hasAdminRole } = useAuth();

  if (!user || !hasAdminRole) {
    return null;
  }

  return (
    <div className="sidebar__user">
      <p className="sidebar__user-email">{user.email ?? user.phone}</p>
      <Button variant="ghost" size="sm" block onClick={() => logout()} disabled={loading}>
        {loading ? '…' : 'Log out'}
      </Button>
    </div>
  );
}
