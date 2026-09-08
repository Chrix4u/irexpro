'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AiIcon,
  DashboardIcon,
  PaymentsIcon,
  MoreIcon,
  PortfolioIcon,
  TradeIcon,
  UserIcon,
  ShieldIcon,
  PlugIcon,
  LogoutIcon,
  CloseIcon,
  type IconProps,
} from '@/components/icons';

/**
 * Responsive mobile navigation for the authenticated trader workspace.
 *
 * The bottom bar intentionally remains three items (Dashboard, Payments,
 * More) to preserve comfortable touch targets. High-value trading workspaces
 * live in the accessible More sheet until the dedicated mobile terminal IA is
 * expanded in a later product slice.
 */
interface NavDestination {
  href: string;
  label: string;
  Icon: ComponentType<IconProps>;
  matchPrefix?: boolean;
}

const PRIMARY_NAV: NavDestination[] = [
  { href: '/dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { href: '/payments/success', label: 'Payments', Icon: PaymentsIcon, matchPrefix: true },
];

const SECONDARY_NAV: NavDestination[] = [
  { href: '/trade', label: 'Trading Workspace', Icon: TradeIcon, matchPrefix: true },
  { href: '/market', label: 'Market Intelligence', Icon: TradeIcon, matchPrefix: true },
  { href: '/ai', label: 'AI Command Center', Icon: AiIcon, matchPrefix: true },
  { href: '/strategy-lab', label: 'Strategy Lab', Icon: AiIcon, matchPrefix: true },
  { href: '/portfolio', label: 'Portfolio & Risk', Icon: PortfolioIcon, matchPrefix: true },
  { href: '/live-account', label: 'Live Account', Icon: PortfolioIcon, matchPrefix: true },
  { href: '/onboarding/profile', label: 'Profile', Icon: UserIcon },
  { href: '/security', label: 'Security', Icon: ShieldIcon },
  { href: '/onboarding/risk', label: 'Risk limits', Icon: ShieldIcon },
  { href: '/onboarding/broker', label: 'Broker', Icon: PlugIcon },
];

function isActive(pathname: string | null, dest: NavDestination): boolean {
  if (!pathname) return false;
  if (dest.matchPrefix) {
    return pathname === dest.href || pathname.startsWith(`${dest.href}/`);
  }
  return pathname === dest.href;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface MobileBottomNavProps {
  onLogout: () => void;
}

export default function MobileBottomNav({ onLogout }: MobileBottomNavProps) {
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

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSheet();
        return;
      }
      if (event.key !== 'Tab') return;

      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusables = Array.from(
        sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.offsetParent !== null);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !sheet.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
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
    // closeSheet is stable through setState and is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moreOpen]);

  function closeSheet() {
    setMoreOpen(false);
  }

  return (
    <>
      <nav className="mobile-bottom-nav" aria-label="Primary mobile navigation">
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
          aria-controls="mobile-more-sheet"
          aria-label="More navigation"
          onClick={() => setMoreOpen(true)}
        >
          <span className="mobile-bottom-nav__icon" aria-hidden="true">
            <MoreIcon size={22} />
          </span>
          <span className="mobile-bottom-nav__label">More</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="mobile-sheet-overlay">
          <button
            type="button"
            className="mobile-sheet-backdrop"
            aria-label="Close navigation sheet"
            tabIndex={-1}
            onClick={closeSheet}
          />
          <div
            id="mobile-more-sheet"
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-more-sheet-title"
            className="mobile-sheet"
          >
            <div className="mobile-sheet__header">
              <h2 id="mobile-more-sheet-title" className="mobile-sheet__title">
                More
              </h2>
              <button
                ref={sheetCloseRef}
                type="button"
                className="mobile-sheet__close"
                aria-label="Close navigation sheet"
                onClick={closeSheet}
              >
                <CloseIcon size={20} />
              </button>
            </div>

            <ul className="mobile-sheet__list">
              {SECONDARY_NAV.map((dest) => {
                const { Icon } = dest;
                const active = isActive(pathname, dest);
                return (
                  <li key={dest.href}>
                    <Link
                      href={dest.href}
                      className="mobile-sheet__item"
                      aria-current={active ? 'page' : undefined}
                      onClick={closeSheet}
                    >
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
