import { test, expect } from '@playwright/test';
import {
  assertNoConsoleErrors,
  assertNoExternalRequests,
  assertNoFailedRequests,
  assertNoHorizontalOverflow,
  mockAuthTokens,
  mockAuthUser,
  setupErrorCollectors,
} from './fixtures';

const safeSnapshot = {
  generatedAt: '2026-08-28T22:30:00.000Z',
  decisions: [
    {
      signalId: '11111111-1111-4111-8111-111111111111',
      outcome: 'EXECUTION_SUCCEEDED',
      receivedAt: '2026-08-28T22:20:00.000Z',
      evidence: {
        instrument: 'EURUSD',
        direction: 'BUY',
        confidenceScore: 0.82,
        strategyCode: 'TREND_H1',
        modelVersion: 'ensemble-v2.3',
        timeframe: 'H1',
        marketRegime: 'trending',
        volatilityScore: 0.42,
        generatedAt: '2026-08-28T22:19:58.000Z',
      },
      agentContext: {
        version: 'agent-council-v1',
        status: 'BLOCKED',
        consensusDirection: 'NEUTRAL',
        weightedSupport: 0,
        weightedOpposition: 0,
        disagreementScore: 0,
        evidenceCount: 1,
        rejectedCount: 0,
        evidence: [
          {
            source: 'MACRO_NEWS',
            sourceId: 'macro-event:bls-cpi',
            stance: 'BLOCK',
            confidence: 1,
            credibility: 1,
            verifiedSources: 1,
            availableAt: '2026-08-28T22:19:50.000Z',
            summary: 'High-impact USD CPI event is within the configured risk window.',
          },
        ],
        sourceState: 'AVAILABLE',
        evaluatedAt: '2026-08-28T22:19:59.000Z',
        advisoryOnly: true,
        executionAuthority: false,
      },
      risk: {
        decision: 'APPROVED',
        rejectionCode: null,
        rejectionReason: null,
      },
      execution: {
        tradeId: '22222222-2222-4222-8222-222222222222',
        status: 'OPEN',
        openedAt: '2026-08-28T22:20:02.000Z',
        closedAt: null,
        closeReason: null,
      },
      timeline: [
        {
          stage: 'SIGNAL',
          status: 'RECEIVED',
          code: null,
          message: 'AI signal received',
          at: '2026-08-28T22:20:00.000Z',
        },
        {
          stage: 'RISK',
          status: 'APPROVED',
          code: null,
          message: 'Risk engine approved the signal',
          at: '2026-08-28T22:20:01.000Z',
        },
        {
          stage: 'EXECUTION',
          status: 'SUCCEEDED',
          code: null,
          message: 'Execution engine accepted the approved signal',
          at: '2026-08-28T22:20:02.000Z',
        },
      ],
    },
    {
      signalId: '33333333-3333-4333-8333-333333333333',
      outcome: 'RISK_REJECTED',
      receivedAt: '2026-08-28T22:10:00.000Z',
      evidence: {
        instrument: 'GBPUSD',
        direction: 'SELL',
        confidenceScore: 0.76,
        strategyCode: 'RANGE_M15',
        modelVersion: 'ensemble-v2.3',
        timeframe: 'M15',
        marketRegime: 'ranging',
        volatilityScore: 0.31,
        generatedAt: '2026-08-28T22:09:59.000Z',
      },
      agentContext: null,
      risk: {
        decision: 'REJECTED',
        rejectionCode: 'MAX_CONCURRENT_TRADES',
        rejectionReason: 'Open trade limit reached',
      },
      execution: null,
      timeline: [
        {
          stage: 'SIGNAL',
          status: 'RECEIVED',
          code: null,
          message: 'AI signal received',
          at: '2026-08-28T22:10:00.000Z',
        },
        {
          stage: 'RISK',
          status: 'REJECTED',
          code: 'MAX_CONCURRENT_TRADES',
          message: 'Open trade limit reached',
          at: '2026-08-28T22:10:01.000Z',
        },
      ],
    },
  ],
};

async function gotoDecisionExplorer(page: Parameters<typeof setupErrorCollectors>[0], body: unknown) {
  setupErrorCollectors(page);
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const apiPath = url.pathname.split('/api/v1/')[1] ?? '';
    const fulfill = (status: number, responseBody: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(responseBody) });

    if (apiPath === 'auth/refresh') return fulfill(200, mockAuthTokens);
    if (apiPath === 'auth/me') return fulfill(200, mockAuthUser);
    if (apiPath === 'auth/logout') return fulfill(200, { message: 'Logged out' });
    if (apiPath === 'ai/decisions') return fulfill(200, body);
    return fulfill(200, {});
  });

  await page.goto('/ai');
  await expect(page.getByRole('heading', { level: 1, name: 'AI Decision Explorer' })).toBeVisible();
}

test.describe('AI Decision Explorer', () => {
  test('renders persisted signal, risk, and execution evidence without internal payloads', async ({ page }) => {
    await gotoDecisionExplorer(page, safeSnapshot);

    await expect(page.getByText('EURUSD · BUY', { exact: true })).toBeVisible();
    await expect(page.getByText('82%', { exact: true })).toBeVisible();
    await expect(page.getByText('TREND_H1', { exact: true })).toBeVisible();
    await expect(page.getByText('Execution Succeeded', { exact: true })).toBeVisible();
    await expect(page.getByText('Agent Council context', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Blocked', { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText('High-impact USD CPI event is within the configured risk window.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Max Concurrent Trades — Open trade limit reached', { exact: true }).first(),
    ).toBeVisible();

    await expect(page.getByText('riskContext', { exact: false })).toHaveCount(0);
    await expect(page.getByText('brokerConnectionId', { exact: false })).toHaveCount(0);
    await expect(page.getByText('idempotencyKey', { exact: false })).toHaveCount(0);
    await expect(page.getByText('rawModelMetadata', { exact: false })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoFailedRequests(page);
    assertNoExternalRequests(page);
  });

  test('fails closed when the decision contract contains an unexpected field', async ({ page }) => {
    await gotoDecisionExplorer(page, {
      ...safeSnapshot,
      decisions: [
        {
          ...safeSnapshot.decisions[0],
          rawModelMetadata: { hidden: true },
        },
      ],
    });

    await expect(page.getByText(/unable to load persisted ai decision evidence/i)).toBeVisible();
    await expect(page.getByText('EURUSD · BUY', { exact: true })).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    assertNoConsoleErrors(page);
    assertNoExternalRequests(page);
  });
});