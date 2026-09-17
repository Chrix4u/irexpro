'use client';

/**
 * InfoTooltip — accessible tooltip/popover for risk-setting explanations.
 *
 * UX-1 component.
 *
 * Behaviour:
 * - Renders a small info-circle (16x16, currentColor) trigger button.
 * - Desktop: opens on hover AND keyboard focus.
 * - Mobile/touch: opens on tap/click (does not depend only on hover).
 * - Closes on Escape, blur, or click-outside.
 * - The trigger has `aria-describedby` pointing to the tooltip panel id.
 * - The panel has `role="tooltip"`.
 * - Positioned above the icon by default; flips below if it would overflow the
 *   top of the viewport.
 * - Horizontally clamps inside the viewport on narrow/mobile screens.
 * - Styled with the existing CSS variables (--bg-elevated, --border, etc.).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export interface InfoTooltipProps {
  /** aria-label for the trigger button, e.g. "Explain maximum daily loss". */
  label: string;
  /** Tooltip text shown in the panel. */
  content: string;
  /** Optional children rendered inside the trigger button (e.g. an icon override). */
  children?: React.ReactNode;
}

type Placement = 'top' | 'bottom';

export function InfoTooltip({ label, content, children }: InfoTooltipProps) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>('top');

  // Recompute placement and horizontal viewport containment whenever the
  // tooltip opens or the viewport/scroll position changes.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const recompute = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const PANEL_HEIGHT_ESTIMATE = panel.offsetHeight || 80;
      const EDGE_PADDING = 12;

      // If there isn't enough room above, show below.
      if (triggerRect.top < PANEL_HEIGHT_ESTIMATE + EDGE_PADDING) {
        setPlacement('bottom');
      } else {
        setPlacement('top');
      }

      // The base tooltip CSS centres the panel above/below the trigger with
      // left:50% + translateX(-50%). Keep that geometry, but constrain the
      // panel to the visual viewport so long risk explanations never clip on
      // 360px-class phones. Reset first so repeated scroll/resize calls do not
      // accumulate the previous correction.
      panel.style.maxWidth = `calc(100vw - ${EDGE_PADDING * 2}px)`;
      panel.style.transform = 'translateX(-50%)';
      const panelRect = panel.getBoundingClientRect();
      const viewportRight = window.innerWidth - EDGE_PADDING;
      let shiftX = 0;

      if (panelRect.right > viewportRight) {
        shiftX -= panelRect.right - viewportRight;
      }
      if (panelRect.left + shiftX < EDGE_PADDING) {
        shiftX += EDGE_PADDING - (panelRect.left + shiftX);
      }

      if (Math.abs(shiftX) > 0.5) {
        panel.style.transform = `translateX(calc(-50% + ${shiftX}px))`;
      }
    };

    recompute();
    window.addEventListener('scroll', recompute, true);
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('scroll', recompute, true);
      window.removeEventListener('resize', recompute);
    };
  }, [open]);

  // Close on click outside or Escape.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        panelRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        // Return focus to the trigger for keyboard users.
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      setOpen((v) => !v);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  // We intentionally use both hover and focus/blur to cover desktop and keyboard.
  // Touch users get onClick (the click handler is fired even when there is no
  // prior hover, so the tooltip opens on first tap).
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <span className="info-tooltip">
      <button
        ref={triggerRef}
        type="button"
        className="info-tooltip__trigger"
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        {children ?? <InfoCircleIcon />}
      </button>

      {open && (
        <span
          ref={panelRef}
          role="tooltip"
          id={tooltipId}
          className={`info-tooltip__panel info-tooltip__panel--${placement}`}
        >
          {content}
        </span>
      )}
    </span>
  );
}

function InfoCircleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="10"
        cy="10"
        r="8.25"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="10" cy="5.75" r="1" fill="currentColor" />
      <path
        d="M10 8.75v5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default InfoTooltip;
