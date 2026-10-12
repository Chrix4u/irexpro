import {
  attachPaperExecutionRoutes,
  classifyPaperRoute,
  derivePaperInitialRisk,
  effectiveShadowCostR,
  PaperTradeAuditRow,
  ShadowAuditRow,
  summarizePaperExitShadows,
  summarizeRealisedPaperTrades,
} from './paper-payoff-shadow-audit';
import { EnsembleShadowOutcome } from './ensemble-shadow-outcome';

const trade = (changes: Partial<PaperTradeAuditRow> = {}): PaperTradeAuditRow => ({
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '0.1',
  entryPrice: '1.1',
  stopLoss: '1.099',
  initialStopLoss: '1.099',
  takeProfit: '1.102',
  initialTakeProfit: '1.102',
  exitPrice: '1.1002',
  realisedPnl: '2.00',
  accountCurrency: 'USD',
  commission: '0',
  swap: '0',
  trailingStopPips: null,
  filledQuantity: '0.1',
  filledEntryPrice: '1.1',
  positionRecordCount: 1,
  hasPartialCloseOrder: false,
  executionRoute: 'NORMAL_PAPER',
  research: false,
  policyVersion: 'p1',
  modelVersion: 'm1',
  costModelVersion: 'c1',
  strategyRoute: 'TREND_CONTINUATION',
  closeReason: 'PROFIT_PROTECTION',
  ...changes,
});
const outcome = (changes: Partial<EnsembleShadowOutcome> = {}): EnsembleShadowOutcome => ({
  version: 'm5-first-hit-72bar-net-r-path-v3',
  status: 'LOSS',
  resolvedAt: '2026-10-12T01:00:00Z',
  barsObserved: 12,
  exitPrice: 1.099,
  grossR: -1,
  netR: -1.1,
  reason: 'STOP_LOSS_HIT',
  postEntryTelemetry: {
    maxFavorableR: 0.8,
    maxAdverseR: -1,
    maxCloseGivebackR: 1.8,
    peakFavorableAt: null,
    reachedHalfR: true,
    reachedOneR: false,
    gaveBackHalfRToLoss: true,
    gaveBackOneRToLoss: false,
    methodology: 'COMPLETED_M5_BARS_BEFORE_EXIT_CONSERVATIVE_V1',
    profitProtectionCounterfactuals: [
      {
        code: 'CLOSE_LOCK_050_GIVEBACK_040',
        activationThresholdR: 0.5,
        givebackTriggerR: 0.4,
        activated: true,
        activationAt: '2026-10-12T00:10:00Z',
        exitedEarly: true,
        exitAt: '2026-10-12T00:15:00Z',
        grossR: 0.3,
        netR: 0.2,
        deltaNetRVsBase: 1.3,
      },
      {
        code: 'CLOSE_LOCK_075_GIVEBACK_050',
        activationThresholdR: 0.75,
        givebackTriggerR: 0.5,
        activated: true,
        activationAt: '2026-10-12T00:10:00Z',
        exitedEarly: true,
        exitAt: '2026-10-12T00:15:00Z',
        grossR: 0.2,
        netR: 0.1,
        deltaNetRVsBase: 1.2,
      },
      {
        code: 'CLOSE_LOCK_100_GIVEBACK_050',
        activationThresholdR: 1,
        givebackTriggerR: 0.5,
        activated: false,
        activationAt: null,
        exitedEarly: false,
        exitAt: null,
        grossR: -1,
        netR: -1.1,
        deltaNetRVsBase: 0,
      },
    ],
  },
  ...changes,
});
const shadow = (changes: Partial<ShadowAuditRow> = {}): ShadowAuditRow => ({
  instrument: 'EURUSD',
  direction: 'BUY',
  evaluatedAt: '2026-10-12T00:00:00Z',
  entryPrice: 1.1,
  stopLoss: 1.099,
  brokerSpreadPrice: 0.00008,
  paperSpreadPrice: 0.0001,
  policyVersion: 'p1',
  modelVersion: 'm1',
  costModelVersion: 'c1',
  strategyRoute: 'TREND_CONTINUATION',
  executionRoute: 'NORMAL_PAPER',
  outcome: outcome(),
  ...changes,
});

describe('PAPER realised payoff audit', () => {
  it('uses the actual fill and original unchanged stop for USD quote risk', () => {
    const risk = derivePaperInitialRisk(trade());
    expect(risk.eligible).toBe(true);
    expect(risk.initialRiskUsd).toBeCloseTo(10);
    expect(risk.realisedR).toBeCloseTo(0.2);
    expect(risk.binaryAssumedR).toBeCloseTo(2);
  });
  it('converts USD base risk at the stop and payoff at the target', () => {
    const risk = derivePaperInitialRisk(
      trade({
        instrument: 'USDJPY',
        entryPrice: 150,
        filledEntryPrice: 150,
        stopLoss: 149,
        initialStopLoss: 149,
        takeProfit: 152,
        initialTakeProfit: 152,
        exitPrice: 150.2,
        realisedPnl: 13.32,
      }),
    );
    expect(risk.initialRiskUsd).toBeCloseTo(10000 / 149);
    expect(risk.realisedR).toBeCloseTo(13.32 / (10000 / 149));
    expect(risk.targetR).toBeCloseTo(20000 / 152 / (10000 / 149));
  });
  it.each([
    [{ initialStopLoss: null }, 'ORIGINAL_STOP_UNPROVEN'],
    [{ stopLoss: 1.0995 }, 'STOP_MODIFIED'],
    [{ trailingStopPips: 1 }, 'TRAILING_STOP'],
    [{ positionRecordCount: 2 }, 'POSITION_NOT_UNIQUE'],
    [{ hasPartialCloseOrder: true }, 'PARTIAL_CLOSE'],
    [{ filledQuantity: 0.05 }, 'FULL_FILL_UNPROVEN'],
    [{ realisedPnl: 1 }, 'FULL_CLOSE_PNL_UNPROVEN'],
    [{ accountCurrency: 'EUR' }, 'ACCOUNT_CURRENCY_UNSUPPORTED'],
    [{ instrument: 'EURGBP' }, 'CONVERSION_UNPROVEN'],
    [{ commission: null }, 'NET_COSTS_UNPROVEN'],
    [{ swap: -0.1 }, 'NET_COSTS_UNPROVEN'],
  ] as Array<[Partial<PaperTradeAuditRow>, string]>)('skips unprovable R: %s', (change, reason) => {
    const risk = derivePaperInitialRisk(trade(change));
    expect(risk.eligible).toBe(false);
    expect(risk.skipReason).toBe(reason);
    expect(risk.realisedR).toBeNull();
  });
  it('keeps research, normal, conflicting and unknown route provenance distinct', () => {
    expect(classifyPaperRoute('NORMAL_PAPER', false)).toBe('NORMAL_PAPER');
    expect(classifyPaperRoute(null, true)).toBe('PAPER_RESEARCH_THROUGHPUT');
    expect(classifyPaperRoute('NORMAL_PAPER', true)).toBe('CONFLICTING_ROUTE');
    expect(classifyPaperRoute(null, null)).toBe('UNKNOWN_ROUTE');
  });
  it('exposes the binary payoff overstatement despite a 50 percent win rate', () => {
    const rows = [
      trade(),
      trade({ exitPrice: 1.099, realisedPnl: -10, closeReason: 'STOP_LOSS_HIT' }),
    ];
    const [group] = summarizeRealisedPaperTrades(rows);
    expect(group.totals.reportedRealisedPnl).toBeCloseTo(-8);
    expect(group.payoff.eligibleTrades).toBe(2);
    expect(group.payoff.meanRealisedR).toBeCloseTo(-0.4);
    expect(group.payoff.meanBinaryAssumedR).toBeCloseTo(0.5);
    expect(group.payoff.binaryOverstatementR).toBeCloseTo(0.9);
    expect(group.payoff.realisedBreakEvenWinRate).toBeCloseTo(1 / 1.2);
    expect(group.pairSides[0].payoff.meanRealisedR).toBeCloseTo(-0.4);
  });
  it('keeps skipped trades in monetary totals without inventing R', () => {
    const [group] = summarizeRealisedPaperTrades([trade({ initialStopLoss: null })]);
    expect(group.totals.closedTrades).toBe(1);
    expect(group.totals.reportedRealisedPnl).toBe(2);
    expect(group.payoff.eligibleTrades).toBe(0);
    expect(group.payoff.meanRealisedR).toBeNull();
    expect(group.payoff.skipReasons).toEqual({ ORIGINAL_STOP_UNPROVEN: 1 });
  });
  it('isolates policy, model, strategy, currency and execution route cohorts', () => {
    const groups = summarizeRealisedPaperTrades([
      trade(),
      trade({ policyVersion: 'p2' }),
      trade({ modelVersion: 'm2' }),
      trade({ executionRoute: 'PAPER_RESEARCH_THROUGHPUT', research: true }),
      trade({ strategyRoute: 'CONFIRMED_REVERSAL' }),
      trade({ accountCurrency: 'EUR' }),
    ]);
    expect(groups).toHaveLength(6);
  });
});

describe('matched completed-M5 exit-policy audit', () => {
  it('budgets the larger recorded P90 and PAPER fill spread with 25 percent buffer', () => {
    expect(effectiveShadowCostR(1.1, 1.099, 0.00008, 0.0001)).toBeCloseTo(0.125);
    expect(effectiveShadowCostR(1.1, 1.099, 0.0002, 0.0001)).toBeCloseTo(0.25);
    expect(effectiveShadowCostR(1.1, 1.099, null, 0.0001)).toBeNull();
    expect(effectiveShadowCostR(1.1, 1.1, 0.0001, 0.0001)).toBeNull();
  });
  it('compares each policy against exactly the same collapsed baseline episodes', () => {
    const rows = [
      shadow(),
      shadow({ evaluatedAt: '2026-10-12T00:05:00Z', outcome: outcome({ grossR: 2, netR: 1.9 }) }),
      shadow({
        evaluatedAt: '2026-10-12T01:05:00Z',
        outcome: outcome({ resolvedAt: '2026-10-12T02:00:00Z' }),
      }),
    ];
    const [group] = summarizePaperExitShadows(rows);
    expect(group.episodeCount).toBe(2);
    expect(group.overlappingRowsCollapsed).toBe(1);
    expect(group.policies).toHaveLength(3);
    const policy = group.policies[0];
    expect(policy.matchedEpisodes).toBe(2);
    expect(policy.baselineEffectiveCost.meanR).toBeCloseTo(-1.125);
    expect(policy.policyEffectiveCost.meanR).toBeCloseTo(0.175);
    expect(policy.meanDeltaR).toBeCloseTo(1.3);
    expect(policy.baselineStoredCost.meanR).toBeCloseTo(-1.1);
    expect(policy.policyStoredCost.meanR).toBeCloseTo(0.2);
  });
  it('extends an overlap cluster to the latest baseline exit before taking the next episode', () => {
    const [group] = summarizePaperExitShadows([
      shadow(),
      shadow({
        evaluatedAt: '2026-10-12T00:50:00Z',
        outcome: outcome({ resolvedAt: '2026-10-12T01:30:00Z' }),
      }),
      shadow({
        evaluatedAt: '2026-10-12T01:05:00Z',
        outcome: outcome({ resolvedAt: '2026-10-12T02:00:00Z' }),
      }),
    ]);
    expect(group.episodeCount).toBe(1);
    expect(group.overlappingRowsCollapsed).toBe(2);
  });
  it('does not fabricate matches for missing policies or unknown costs', () => {
    const base = outcome();
    base.postEntryTelemetry!.profitProtectionCounterfactuals =
      base.postEntryTelemetry!.profitProtectionCounterfactuals.slice(0, 1);
    const [group] = summarizePaperExitShadows([shadow({ outcome: base, brokerSpreadPrice: null })]);
    expect(group.policies[0].matchedEpisodes).toBe(0);
    expect(group.policies[0].skipReasons).toEqual({ EXECUTION_COST_UNPROVEN: 1 });
    expect(group.policies[1].skipReasons).toEqual({ POLICY_OUTCOME_MISSING: 1 });
  });
  it('isolates hypothetical outcomes by provenance and keeps ambiguity out of payoffs', () => {
    const groups = summarizePaperExitShadows([
      shadow(),
      shadow({ policyVersion: 'p2' }),
      shadow({ executionRoute: 'PAPER_RESEARCH_THROUGHPUT' }),
      shadow({ outcome: outcome({ status: 'AMBIGUOUS', grossR: null, netR: null }) }),
      shadow({ outcome: null }),
    ]);
    expect(groups).toHaveLength(3);
    const group = groups.find(
      (g) => g.cohort.policyVersion === 'p1' && g.cohort.executionRoute === 'NORMAL_PAPER',
    )!;
    expect(group.ambiguousRows).toBe(1);
    expect(group.unresolvedRows).toBe(1);
    expect(group.policies[0].matchedEpisodes).toBe(1);
  });
});

describe('shadow execution route provenance', () => {
  it('links exact policy, pair, side and UTC market bar without inferring unexecuted research routes', () => {
    const rows = [
      shadow({ marketBarTime: '2026-10-12T00:00:00Z' }),
      shadow({ marketBarTime: '2026-10-12T00:05:00Z' }),
      shadow({ marketBarTime: '2026-10-12T00:00:00Z', policyVersion: 'p2' }),
    ];
    const linked = attachPaperExecutionRoutes(rows, [
      {
        instrument: 'EURUSD',
        direction: 'BUY',
        marketBarTime: '2026-10-12T00:00:00.000Z',
        policyVersion: 'p1',
        executionRoute: 'PAPER_RESEARCH_THROUGHPUT',
        research: true,
      },
    ]);
    expect(linked.map((row) => row.executionRoute)).toEqual([
      'PAPER_RESEARCH_THROUGHPUT',
      'SHADOW_UNLINKED',
      'SHADOW_UNLINKED',
    ]);
    expect(rows[0].executionRoute).toBe('NORMAL_PAPER');
  });
  it('keeps multiply routed executions separate from either normal or research', () => {
    const common = {
      instrument: 'EURUSD',
      direction: 'BUY' as const,
      marketBarTime: '2026-10-12T00:00:00Z',
      policyVersion: 'p1',
    };
    const linked = attachPaperExecutionRoutes(
      [shadow({ marketBarTime: common.marketBarTime })],
      [
        { ...common, executionRoute: 'NORMAL_PAPER', research: false },
        { ...common, executionRoute: 'PAPER_RESEARCH_THROUGHPUT', research: true },
      ],
    );
    expect(linked[0].executionRoute).toBe('MULTIPLE_EXECUTION_ROUTES');
  });
});
