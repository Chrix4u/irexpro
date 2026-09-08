'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  DashboardIcon,
  UsersIcon,
  PlugIcon,
  PaymentsIcon,
  MoreIcon,
  AuditIcon,
  LogoutIcon,
  CloseIcon,
  PulseIcon,
  type IconProps,
} from '@/components/icons';

interface NavDestination {
  href: string;
  label: string;
  Icon: ComponentType<IconProps>;
  matchPrefix?: boolean;
}

const PRIMARY_NAV: NavDestination[] = [
  { href: '/admin/dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { href: '/admin/users', label: 'Users', Icon: UsersIcon, matchPrefix: true },
  { href: '/admin/brokers', label: 'Brokers', Icon: PlugIcon, matchPrefix: true },
  { href: '/admin/payments', label: 'Payments', Icon: PaymentsIcon, matchPrefix: true },
];

const SECONDARY_NAV: NavDestination[] = [
  { href: '/admin/live-ops', label: 'Live ops', Icon: PulseIcon },
  { href: '/admin/account-appeals', label: 'Account reviews', Icon: UsersIcon },
  { href: '/admin/eligibility-reviews', label: 'Eligibility reviews', Icon: AuditIcon },
  { href: '/admin/kyc-reviews', label: 'KYC reviews', Icon: UsersIcon },
  { href: '/admin/audit', label: 'Audit log', Icon: AuditIcon },
];

function isActive(pathname: string | null, dest: NavDestination): boolean {
  if (!pathname) return false;
  if (dest.matchPrefix) {
    return pathname === dest.href || pathname.startsWith(dest.href + '/');
  }
  return pathname === dest.href;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface AdminMobileBottomNavProps {
  onLogout: () => void;
}

export default function AdminMobileBottomNav({ onLogout }: AdminMobileBottomNavProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetCloseRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!moreOpen) return;

    previouslyFocusedRef.current = moreButtonRef.current;

    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const rafId = requestAnimationFrame(() => {
      sheetCloseRef.current?.focus();
    });

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMoreOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusables = Array.from(
        sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !sheet.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);

    return () => {
      document.removeEventListener('keydown', handleKey);
      cancelAnimationFrame(rafId);
      document.body.style.overflow = prevBodyOverflow;
      previouslyFocusedRef.current?.focus();
    };
  }, [moreOpen]);

  function closeSheet() {
    setMoreOpen(false);
  }

  return (
    <>
      <nav className="mobile-bottom-nav" aria-label="Admin primary mobile navigation">
        {PRIMARY_NAV.map((dest) => {
          const active = isActive(pathname, dest);
          const { Icon } = dest;
          return (
            <Link
              key={dest.href}
              href={dest.href}
              className={`mobile-bottom-nav__item${active ? ' mobile-bottom-nav__item--active' : ''}`}
              aria-current={active ? 'page' : undefined}
              aria-label={dest.label}
            >
              <span className="mobile-bottom-nav__icon" aria-hidden="true">
                <Icon size={22} />
              </span>
              <span className="mobile-bottom-nav__label">{dest.label}</span>
            </Link>
          );
        })}
        <button
          ref={moreButtonRef}
          type="button"
          className={`mobile-bottom-nav__item${moreOpen ? ' mobile-bottom-nav__item--active' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-controls="admin-mobile-more-sheet"
          aria-label="More admin navigation"
          onClick={() => setMoreOpen(true)}
        >
          <span className="mobile-bottom-nav__icon" aria-hidden="true">
            <MoreIcon size={22} />
          </span>
          <span className="mobile-bottom-nav__label">More</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="mobile-sheet-overlay" onClick={closeSheet}>
          <div
            id="admin-mobile-more-sheet"
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-mobile-more-sheet-title"
            className="mobile-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-sheet__header">
              <h2 id="admin-mobile-more-sheet-title" className="mobile-sheet__title">
                More
              </h2>
              <button
                ref={sheetCloseRef}
                type="button"
                className="mobile-sheet__close"
                aria-label="Close more navigation"
                onClick={closeSheet}
              >
                <CloseIcon size={20} />
              </button>
            </div>
            <ul className="mobile-sheet__list">
              {SECONDARY_NAV.map((dest) => {
                const { Icon } = dest;
                return (
                  <li key={dest.href}>
                    <Link href={dest.href} className="mobile-sheet__item" onClick={closeSheet}>
                      <span className="mobile-sheet__item-icon" aria-hidden="true">
                        <Icon size={20} />
                      </span>
                      <span>{dest.label}</span>
                    </Link>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  className="mobile-sheet__item mobile-sheet__item--danger"
                  onClick={() => {
                    closeSheet();
                    onLogout();
                  }}
                >
                  <span className="mobile-sheet__item-icon" aria-hidden="true">
                    <LogoutIcon size={20} />
                  </span>
                  <span>Log out</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
