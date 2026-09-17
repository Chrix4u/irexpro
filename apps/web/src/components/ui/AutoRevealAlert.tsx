'use client';

import { useEffect, useRef, type ReactNode } from 'react';

type AlertVariant = 'error' | 'success' | 'warning' | 'info';

/**
 * Inline alert that only auto-scrolls when a newly rendered actionable alert
 * is already ABOVE the user's viewport. This avoids jumping to static warnings
 * lower on the page while still bringing errors/warnings back into view after
 * the user triggers an action from farther down the screen.
 */
export function AutoRevealAlert({
  variant = 'info',
  children,
}: {
  variant?: AlertVariant;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (variant !== 'error' && variant !== 'warning') return;
    const element = ref.current;
    if (!element) return;

    const frame = window.requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom < 0) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.focus({ preventScroll: true });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [variant, children]);

  return (
    <div
      ref={ref}
      className={`alert alert--${variant}`}
      role={variant === 'error' ? 'alert' : 'status'}
      aria-live={variant === 'error' ? 'assertive' : 'polite'}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

export default AutoRevealAlert;