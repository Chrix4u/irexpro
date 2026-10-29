import type { ExecutionConfirmationView } from '@irexpro/types/execution';
import {
  changeSessionExecutionMode,
  confirmPendingConfirmation,
  connectionVerificationLabel,
  dailyLossProtectionMessage,
  dailyRiskCooldownFromViolation,
  executionBlockedReasons,
  formatExpiryCountdown,
  loadPendingExecutionConfirmations,
  prepareBrokerForAutomationStart,
  resetDailyLossProtection,
  resetDailyLossProtectionForBroker,
  shouldOfferRiskResetAfterEndedSession,
} from './trader-session';

/**
 * Execution-authority truthfulness tests (Sprint 56 correction round 5,
 * issues #292/#293/#298).
 *
 * Invariants under test:
 * - the mode-change call goes to the audited endpoint and the RETURNED
 *   session (bumped generation) becomes the displayed state;
 * - a confirm NEVER resolves to a locally-fabricated approval — only the
 *   server's `{ status: 'CONSUMED' }` does, and 409s surface the server's
 *   typed failure kind;
 * - blocked reasons come from server-reported facts only;
 * - the connection verification label is drawn from the EXACT six-label
 *   taxonomy and degrades fail-closed.
 */

jest.mock('@/lib/api', () => ({
  api: {
    request: jest.fn(),
    changeTradingSessionMode: jest.fn(),
    startTradingSession: jest.fn(),
    listPendingExecutionConfirmations: jest.fn(),
    confirmExecutionConfirmation: jest.fn(),
  },
}));

import { api } from '@/lib/api';
import { ApiClientError } from '@irexpro/api-client';

const changeModeMock = api.changeTradingSessionMode as jest.Mock;
const confirmMock = api.confirmExecutionConfirmation as jest.Mock;
const pendingMock = api.listPendingExecutionConfirmations as jest.Mock;
const requestMock = api.request as jest.Mock;

const SESSION = {
  id: 'sess_00000000-0000-0000-0000-000000000001',
  brokerConnectionId: 'bconn_00000000-0000-0000-0000-000000000001',
  executionMode: 'SEMI_AUTO',
  authorityGeneration: 3,
  status: 'ACTIVE',
  startedAt: '2026-09-10T00:00:00.000Z',
} as const;

const CONFIRMATION = {
  id: 'conf_00000000-0000-0000-0000-000000000001',
  signalId: 'sig_00000000-0000-0000-0000-000000000001',
  instrument: 'EURUSD',
  direction: 'BUY',
  quantity: '0.10',
  stopLoss: '1.09500000',
  takeProfit: '1.11000000',
  expiresAt: '2026-09-10T00:05:00.000Z',
  orderPayloadDigest: 'sha256:fixture-digest',
} satisfies ExecutionConfirmationView;

describe('prepareBrokerForAutomationStart', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  const externalDemo = {
    id: 'bconn-demo-1',
    brokerId: 'ctrader',
    accountType: 'DEMO',
    authorizationStatus: 'CONNECTED',
    demoValidated: false,
  } as const;

  it('validates an unvalidated external DEMO before enabling automation', async () => {
    requestMock
      .mockResolvedValueOnce({
        overall: 'PASS',
        demoValidated: true,
        steps: [{ name: 'connect', status: 'PASS', detail: 'connected' }],
      })
      .mockResolvedValueOnce(undefined);

    const result = await prepareBrokerForAutomationStart(externalDemo);

    expect(result).toEqual({ ready: true });
    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      '/broker/connections/bconn-demo-1/validate-demo',
      { method: 'POST' },
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      '/broker/connections/bconn-demo-1/enable-demo-trading',
      { method: 'POST' },
    );
  });

  it('fails closed and does not enable automation when DEMO validation fails', async () => {
    requestMock.mockResolvedValueOnce({
      overall: 'FAIL',
      demoValidated: false,
      steps: [
        { name: 'market-data', status: 'FAIL', detail: 'No fresh EURUSD quote was available.' },
      ],
    });

    const result = await prepareBrokerForAutomationStart(externalDemo);

    expect(result).toEqual({
      ready: false,
      message: 'DEMO validation failed at market-data: No fresh EURUSD quote was available.',
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('skips re-validation when evidence already exists, but still activates the DEMO authority', async () => {
    requestMock.mockResolvedValueOnce(undefined);

    const result = await prepareBrokerForAutomationStart({
      ...externalDemo,
      demoValidated: true,
    });

    expect(result).toEqual({ ready: true });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      '/broker/connections/bconn-demo-1/enable-demo-trading',
      { method: 'POST' },
    );
  });

  it('does not touch validation or DEMO activation for paper, live, or already ACTIVE brokers', async () => {
    for (const broker of [
      { ...externalDemo, brokerId: 'paper-broker' },
      { ...externalDemo, accountType: 'LIVE' as const },
      { ...externalDemo, authorizationStatus: 'ACTIVE' as const },
    ]) {
      await expect(prepareBrokerForAutomationStart(broker)).resolves.toEqual({ ready: true });
    }

    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('changeSessionExecutionMode', () => {
  beforeEach(() => {
    changeModeMock.mockReset();
  });

  it('calls the audited mode endpoint and returns the server session (bumped generation)', async () => {
    // The API returns the session DTO directly (bare object, no envelope).
    changeModeMock.mockResolvedValue({
      ...SESSION,
      executionMode: 'FULL_AUTO',
      authorityGeneration: 4,
    });

    const session = await changeSessionExecutionMode(SESSION.id, 'FULL_AUTO');

    expect(changeModeMock).toHaveBeenCalledWith(SESSION.id, {
      executionMode: 'FULL_AUTO',
    });
    expect(session.executionMode).toBe('FULL_AUTO');
    expect(session.authorityGeneration).toBe(4);
  });

  it('fails closed when the response is not a session object', async () => {
    // A malformed payload (missing required authority fields) must never be
    // trusted as the new state.
    changeModeMock.mockResolvedValue({ executionMode: 'FULL_AUTO' });

    await expect(changeSessionExecutionMode(SESSION.id, 'FULL_AUTO')).rejects.toThrow(
      'Trading session mode-change contract mismatch',
    );
  });
});

describe('resetDailyLossProtection', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('posts the explicit daily-loss reset and trusts only the returned server session', async () => {
    requestMock.mockResolvedValue({
      session: {
        ...SESSION,
        status: 'ACTIVE',
        authorityGeneration: 4,
      },
      resetAt: '2026-10-28T15:00:00.000Z',
      resetCount: 1,
      message:
        'Daily-loss protection was reset from this moment and AI Trading resumed. Historical P&L was not changed.',
    });

    const result = await resetDailyLossProtection(SESSION.id);

    expect(requestMock).toHaveBeenCalledWith(
      `/trading/sessions/${encodeURIComponent(SESSION.id)}/reset-daily-loss`,
      {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      },
    );
    expect(result.session.status).toBe('ACTIVE');
    expect(result.session.authorityGeneration).toBe(4);
    expect(result.resetCount).toBe(1);
  });

  it('fails closed when the reset response does not contain a valid resumed session', async () => {
    requestMock.mockResolvedValue({
      session: { id: SESSION.id, status: 'ACTIVE' },
      resetAt: '2026-10-28T15:00:00.000Z',
      resetCount: 1,
      message: 'reset',
    });

    await expect(resetDailyLossProtection(SESSION.id)).rejects.toThrow(
      'Daily-loss reset response contract mismatch',
    );
  });
});

describe('resetDailyLossProtectionForBroker', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('posts an explicit broker-level daily-loss reset when no suspended session survives', async () => {
    requestMock.mockResolvedValue({
      resetAt: '2026-10-28T16:30:00.000Z',
      resetCount: 1,
      message:
        'Daily-loss protection was reset from this moment. Historical P&L was not changed. AI Trading remains stopped until a new session starts.',
    });

    const result = await resetDailyLossProtectionForBroker('bconn-demo-1');

    expect(requestMock).toHaveBeenCalledWith('/trading/sessions/daily-loss/reset', {
      method: 'POST',
      body: JSON.stringify({ brokerConnectionId: 'bconn-demo-1', confirmed: true }),
    });
    expect(result.resetCount).toBe(1);
  });
});

describe('loadPendingExecutionConfirmations', () => {
  beforeEach(() => {
    pendingMock.mockReset();
  });

  it('accepts the server-queued confirmation rows (full order detail preserved)', async () => {
    pendingMock.mockResolvedValue({ confirmations: [CONFIRMATION] });

    const confirmations = await loadPendingExecutionConfirmations();

    expect(confirmations).toEqual([CONFIRMATION]);
  });

  it('rejects a malformed confirmation row (fail-closed)', async () => {
    pendingMock.mockResolvedValue({
      confirmations: [{ ...CONFIRMATION, direction: 'SIDEWAYS' }],
    });

    await expect(loadPendingExecutionConfirmations()).rejects.toThrow(
      'Pending execution confirmations contract mismatch',
    );
  });
});

describe('confirmPendingConfirmation', () => {
  beforeEach(() => {
    confirmMock.mockReset();
  });

  it('resolves CONSUMED only from the server result', async () => {
    confirmMock.mockResolvedValue({ status: 'CONSUMED' });

    const result = await confirmPendingConfirmation(CONFIRMATION.id);

    expect(confirmMock).toHaveBeenCalledWith(CONFIRMATION.id);
    expect(result).toEqual({ outcome: 'CONSUMED' });
  });

  it('never fabricates approval when the 200 body is unexpected', async () => {
    confirmMock.mockResolvedValue({ status: 'PENDING' });

    const result = await confirmPendingConfirmation(CONFIRMATION.id);

    expect(result.outcome).toBe('FAILED');
    if (result.outcome === 'FAILED') {
      expect(result.failure.kind).toBe('unknown');
    }
  });

  it('surfaces the server 409 typed failure for an expired confirmation', async () => {
    confirmMock.mockRejectedValue(
      new ApiClientError(409, 'Confirmation expired', {
        statusCode: 409,
        message: 'Confirmation expired',
      }),
    );

    const result = await confirmPendingConfirmation(CONFIRMATION.id);

    expect(result.outcome).toBe('FAILED');
    if (result.outcome === 'FAILED') {
      expect(result.failure.kind).toBe('expired');
      expect(result.failure.message).toBe('Confirmation expired');
    }
  });

  it('surfaces the server 409 typed failure for an authority-generation mismatch', async () => {
    confirmMock.mockRejectedValue(
      new ApiClientError(409, 'Session authority generation mismatch', {
        statusCode: 409,
        code: 'AUTHORITY_GENERATION_MISMATCH',
        message: 'Session authority generation mismatch',
      }),
    );

    const result = await confirmPendingConfirmation(CONFIRMATION.id);

    expect(result.outcome).toBe('FAILED');
    if (result.outcome === 'FAILED') {
      expect(result.failure.kind).toBe('mismatched-generation');
    }
  });
});

describe('formatExpiryCountdown', () => {
  const now = new Date('2026-09-10T00:00:00.000Z');

  it('formats the remaining window as mm:ss', () => {
    expect(formatExpiryCountdown('2026-09-10T00:04:30.000Z', now)).toBe('04:30');
  });

  it('reports Expired once the server-side window has passed', () => {
    expect(formatExpiryCountdown('2026-09-09T23:59:00.000Z', now)).toBe('Expired');
  });
});

describe('dailyLossProtectionMessage', () => {
  it('states explicitly that daily-loss protection blocks every new entry and preserves the server reason', () => {
    expect(
      dailyLossProtectionMessage({
        maxDailyLossPercent: '5.00',
        rejectionReason:
          'Daily loss 51.45 has reached limit (5.00% = 46.01 of the session opening balance 920.12)',
      }),
    ).toBe(
      'All new AI entries are blocked by daily-loss protection. Daily-loss limit: 5.00%. Daily loss 51.45 has reached limit (5.00% = 46.01 of the session opening balance 920.12)',
    );
  });
});

describe('shouldOfferRiskResetAfterEndedSession', () => {
  it('offers an explicit reset after an ended max-drawdown suspension', () => {
    expect(
      shouldOfferRiskResetAfterEndedSession({
        dailyRiskCooldownActive: false,
        latestRiskSuspensionCode: 'MAX_DRAWDOWN_REACHED',
      }),
    ).toBe(true);
  });

  it('offers the reset when the current persisted protection is daily loss', () => {
    expect(
      shouldOfferRiskResetAfterEndedSession({
        dailyRiskCooldownActive: true,
        latestRiskSuspensionCode: 'DAILY_LOSS_LIMIT_REACHED',
      }),
    ).toBe(true);
  });

  it('allows the daily-loss ledger to drive the control when no newer suspension code exists', () => {
    expect(
      shouldOfferRiskResetAfterEndedSession({
        dailyRiskCooldownActive: true,
        latestRiskSuspensionCode: null,
      }),
    ).toBe(true);
  });

  it('does not offer a reset for unrelated risk rejection codes', () => {
    expect(
      shouldOfferRiskResetAfterEndedSession({
        dailyRiskCooldownActive: false,
        latestRiskSuspensionCode: 'INSUFFICIENT_MARGIN',
      }),
    ).toBe(false);
  });
});

describe('dailyRiskCooldownFromViolation', () => {
  it('blocks Start through UTC midnight after a same-day daily-loss violation', () => {
    expect(
      dailyRiskCooldownFromViolation(
        {
          rejectionCode: 'DAILY_LOSS_LIMIT_REACHED',
          rejectionReason:
            'Daily loss 54.68 has reached limit (5.00% = 49.41 of opening balance 988.13)',
          evaluatedAt: '2026-10-28T13:43:13.000Z',
        },
        new Date('2026-10-28T20:00:00.000Z'),
      ),
    ).toEqual({
      active: true,
      resumeAt: '2026-10-29T00:00:00.000Z',
      reason:
        'Daily loss 54.68 has reached limit (5.00% = 49.41 of opening balance 988.13)',
    });
  });

  it('expires naturally on the next UTC risk day', () => {
    expect(
      dailyRiskCooldownFromViolation(
        {
          rejectionCode: 'DAILY_LOSS_LIMIT_REACHED',
          rejectionReason: 'Daily loss limit reached',
          evaluatedAt: '2026-10-28T23:59:00.000Z',
        },
        new Date('2026-10-29T00:00:01.000Z'),
      ).active,
    ).toBe(false);
  });

  it('ignores non-daily-loss violations', () => {
    expect(
      dailyRiskCooldownFromViolation(
        {
          rejectionCode: 'INSUFFICIENT_MARGIN',
          rejectionReason: 'Insufficient margin',
          evaluatedAt: '2026-10-28T13:43:13.000Z',
        },
        new Date('2026-10-28T20:00:00.000Z'),
      ).active,
    ).toBe(false);
  });
});

describe('executionBlockedReasons', () => {
  it('reports no reasons when every server fact is clear', () => {
    expect(
      executionBlockedReasons({
        session: { ...SESSION, status: 'ACTIVE' },
        killSwitchActive: false,
        canTrade: true,
        brokerConnected: true,
        sessionAuthorizationStatus: 'ACTIVE',
        sessionConnectionExecutable: true,
      }),
    ).toEqual([]);
  });

  it('does not reinterpret AUTHORIZED as blocked when the server executable gate is true', () => {
    expect(
      executionBlockedReasons({
        session: { ...SESSION, status: 'ACTIVE', executionMode: 'PAPER_ONLY' },
        killSwitchActive: false,
        canTrade: true,
        brokerConnected: true,
        sessionAuthorizationStatus: 'AUTHORIZED',
        sessionConnectionExecutable: true,
      }),
    ).toEqual([]);
  });

  it('derives each authoritative blocking reason from server-reported state only', () => {
    const reasons = executionBlockedReasons({
      session: { ...SESSION, status: 'SUSPENDED_RISK_LIMIT' },
      killSwitchActive: true,
      canTrade: false,
      brokerConnected: true,
      sessionAuthorizationStatus: 'SUSPENDED',
      sessionConnectionExecutable: false,
    });

    expect(reasons.some((reason) => reason.includes('Kill switch'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('Risk gate'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('Risk protection paused AI Trading'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('not executable'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('Broker authorization'))).toBe(false);
  });

  it('surfaces the latest server risk violation in plain language for a risk-suspended session', () => {
    const reasons = executionBlockedReasons({
      session: { ...SESSION, status: 'SUSPENDED_RISK_LIMIT' },
      killSwitchActive: false,
      canTrade: false,
      brokerConnected: true,
      sessionAuthorizationStatus: 'SUSPENDED',
      sessionConnectionExecutable: false,
      latestRiskViolationReason:
        'Daily loss 54.68 has reached limit (5.00% = 49.41 of the session opening balance 988.13)',
    } as Parameters<typeof executionBlockedReasons>[0] & { latestRiskViolationReason: string });

    expect(reasons).toContain(
      'Risk protection paused AI Trading: Daily loss 54.68 has reached limit (5.00% = 49.41 of the session opening balance 988.13)',
    );
  });

  it('reports the missing session first when no session is active', () => {
    const reasons = executionBlockedReasons({
      session: null,
      killSwitchActive: false,
      canTrade: true,
      brokerConnected: true,
      sessionAuthorizationStatus: null,
      sessionConnectionExecutable: null,
    });

    expect(reasons).toEqual([
      'No active trading session — execution authority is not started.',
    ]);
  });
});

describe('connectionVerificationLabel', () => {
  it('labels an UNVERIFIED BETA provider connection from the fixed taxonomy (never "Live")', () => {
    const assessment = connectionVerificationLabel(
      {
        accountType: 'LIVE',
        authorizationStatus: 'AUTHORIZED',
        executable: false,
      },
      {
        id: 'ctrader',
        name: 'cTrader',
        description: '',
        status: 'BETA',
        connectionRoutes: ['CTRADER'],
        capabilities: ['DEMO', 'LIVE'],
        authenticationType: 'OAUTH',
        environments: ['DEMO', 'LIVE'],
        regions: [],
        adapterAvailable: true,
        productionLiveVerification: {
          status: 'UNVERIFIED',
          verifiedAt: null,
          evidenceRef: null,
        },
      },
    );

    expect(assessment.label).toBe('Production LIVE Unverified');
    expect(assessment.connectionExecutability).toBe('execution disabled');
  });

  it('degrades fail-closed when the registry entry is missing', () => {
    const assessment = connectionVerificationLabel(
      { accountType: 'LIVE', authorizationStatus: 'ACTIVE', executable: true },
      null,
    );

    expect(assessment.label).toBe('Production LIVE Unverified');
  });

  it('labels a demo identity DEMO only', () => {
    const assessment = connectionVerificationLabel(
      { accountType: 'DEMO', authorizationStatus: 'ACTIVE', executable: true },
      null,
    );

    expect(assessment.label).toBe('DEMO only');
  });
});
