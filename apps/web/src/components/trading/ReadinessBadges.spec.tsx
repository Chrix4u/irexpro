import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { LiveReadinessView } from '@irexpro/types/live-account';
import { ReadinessBadges } from './ReadinessBadges';

/**
 * ReadinessBadges tests (October UAT hardening, WS5-WEB).
 *
 * - The section is named for assistive technology and every badge is a
 *   status indicator with an UNAMBIGUOUS label (never a bare "Verified").
 * - A met state renders success styling; an unmet/unknown state renders the
 *   explicit NOT/UNKNOWN label muted — a DEMO-verified state never renders
 *   as LIVE-ready, and a certified broker never implies model approval.
 * - Real-money blocker copy renders verbatim from the server payload.
 *
 * The api transport is mocked so importing the lib module never touches the
 * real environment-dependent client.
 */

jest.mock('@/lib/api', () => ({
  api: {
    request: jest.fn(),
  },
}));

const readiness = (overrides: Partial<LiveReadinessView> = {}): LiveReadinessView => ({
  generatedAt: '2026-10-01T12:00:00.000Z',
  paper: { ready: true },
  demo: { verified: false },
  brokerLiveCertified: { certified: false, certifiedProviders: [] },
  model: {
    activeModelVersion: 'mtf-xgboost-v1',
    paperApproved: true,
    liveApproved: false,
    liveActivationReason: 'No LIVE promotion record for the active model.',
  },
  liveTradingEnabled: { enabled: false },
  liveBlockers: [
    {
      reasonCode: 'BROKER_NOT_LIVE_CERTIFIED',
      message: 'No broker has completed production-LIVE certification.',
    },
  ],
  ...overrides,
});

describe('ReadinessBadges', () => {
  it('renders an accessibly named section with the six separated badges as status indicators', () => {
    render(<ReadinessBadges readiness={readiness()} />);

    expect(screen.getByRole('heading', { name: 'Trading readiness' })).toBeInTheDocument();

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(6);

    expect(screen.getByText('PAPER READY')).toBeInTheDocument();
    expect(screen.getByText('DEMO NOT VALIDATED')).toBeInTheDocument();
    expect(screen.getByText('BROKER NOT LIVE CERTIFIED')).toBeInTheDocument();
    expect(screen.getByText('MODEL PAPER APPROVED')).toBeInTheDocument();
    expect(screen.getByText('MODEL NOT LIVE APPROVED')).toBeInTheDocument();
    expect(screen.getByText('LIVE TRADING NOT ENABLED')).toBeInTheDocument();
  });

  it('styles met states as success and unmet states as muted info badges', () => {
    render(<ReadinessBadges readiness={readiness()} />);

    expect(screen.getByText('PAPER READY')).toHaveClass('badge--success');
    expect(screen.getByText('PAPER READY').closest('li')).not.toHaveClass(
      'readiness-badge--muted',
    );

    expect(screen.getByText('DEMO NOT VALIDATED')).toHaveClass('badge--info');
    expect(screen.getByText('DEMO NOT VALIDATED').closest('li')).toHaveClass(
      'readiness-badge--muted',
    );
  });

  it('renders MODEL STATUS UNKNOWN muted when the model approval is unknown', () => {
    render(
      <ReadinessBadges
        readiness={readiness({
          model: {
            activeModelVersion: null,
            paperApproved: null,
            liveApproved: false,
            liveActivationReason: null,
          },
        })}
      />,
    );

    const badge = screen.getByText('MODEL STATUS UNKNOWN');
    expect(badge.closest('li')).toHaveClass('readiness-badge--muted');
  });

  it('renders the real-money blockers verbatim under their heading', () => {
    render(<ReadinessBadges readiness={readiness()} />);

    expect(
      screen.getByRole('heading', { name: 'Real-money trading blockers' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No broker has completed production-LIVE certification.'),
    ).toBeInTheDocument();
  });

  it('omits the blockers block entirely when the server reports none', () => {
    render(<ReadinessBadges readiness={readiness({ liveBlockers: [] })} />);

    expect(
      screen.queryByRole('heading', { name: 'Real-money trading blockers' }),
    ).not.toBeInTheDocument();
  });
});
