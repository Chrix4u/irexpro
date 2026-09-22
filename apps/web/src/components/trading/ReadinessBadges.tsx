'use client';

/**
 * ReadinessBadges — the six SEPARATED operating states as distinct badges
 * (October UAT hardening, WS5-WEB).
 *
 * Evidence classes never bleed into each other: a DEMO validation never
 * renders as broker-LIVE certification, a certified broker never implies the
 * active AI model is approved, and model approval never implies LIVE trading
 * is enabled. Every not-ready state renders as its own muted, explicitly
 * labelled badge (never a bare "Verified"), and the real-money blocker copy
 * below is rendered verbatim from the server payload — never invented
 * client-side. The section is named for assistive technology and each badge
 * is a status indicator.
 */

import type { LiveReadinessView } from '@irexpro/types/live-account';
import { Badge } from '@/components/ui';
import { tradingReadinessPanelView } from '@/lib/live-account';

export function ReadinessBadges({ readiness }: { readiness: LiveReadinessView }) {
  const view = tradingReadinessPanelView(readiness);

  return (
    <section
      className="activity-section readiness-section"
      aria-labelledby="trading-readiness-title"
    >
      <div className="activity-section__head">
        <div>
          <p className="workspace-hero__eyebrow">Server-verified truth</p>
          <h2 id="trading-readiness-title">Trading readiness</h2>
        </div>
      </div>

      <ul className="readiness-badge-list">
        {view.badges.map((badge) => (
          <li
            key={badge.key}
            className={badge.met ? 'readiness-badge' : 'readiness-badge readiness-badge--muted'}
            role="status"
          >
            <Badge variant={badge.met ? 'success' : 'info'}>{badge.label}</Badge>
          </li>
        ))}
      </ul>

      <p className="readiness-section__hint">
        Six independent states — each carries its own server-verified evidence.
        {readiness.model.activeModelVersion
          ? ` Active AI model: ${readiness.model.activeModelVersion}.`
          : ' No AI model is active in the runtime.'}
      </p>

      {view.blockers.length > 0 && (
        <div className="readiness-blockers">
          <h3 className="readiness-blockers__title">Real-money trading blockers</h3>
          <ul className="readiness-blockers__list">
            {view.blockers.map((blocker) => (
              <li key={blocker.key}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
