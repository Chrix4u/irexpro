import { ConfigService } from '@nestjs/config';
import { AiSignalService } from './ai-signal.service';
import {
  VpsForexSignalCollectorService,
  canExecuteMultiModelPaper,
  buildCandidate,
  buildDirectionalCandidates,
  aggregateCompletedCandles,
  selectCounterfactualExecutionCandidate,
  prioritizeCounterfactualExecutionRoutes,
  dynamicPaperLotUpperBound,
  isFreshOpportunity,
  evaluatePaperEntryMarketAlignment,
  executableNetExpectedR,
  isPaperLocalShadowEdgeScoutReason,
  adaptiveCalibrationExecutionBlockers,
  paperOpportunityScoutModelVersion,
  canHighConvictionLocalScoutOverrideRealisedRoute,
} from './vps-forex-signal-collector.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { BrokerService } from '../broker/broker.service';
import { LivePaperMarketDataService } from '../broker/services/live-paper-market-data.service';
import * as PlanBEnsembleModule from './plan-b-multimodel-shadow';
import * as EnsembleGovernanceModule from './ensemble-governance';
import { ENSEMBLE_OUTCOME_MODEL_VERSION } from './ensemble-shadow-outcome';
import * as V8ShadowMetaModule from './v8-shadow-meta-scorer';
import * as PairedDirectionReversalModule from './paired-direction-reversal';
import * as PaperSpreadCalibrationModule from './paper-spread-calibration-shadow';
import { PAPER_POST_LOSS_STATE_QUERY } from './paper-post-loss-state-query';
import * as PaperPostLossEntryGuardModule from './paper-post-loss-entry-guard';
import * as PaperOpportunityScoutModule from './paper-opportunity-scout';
import * as PaperChampionDirectionPriorModule from './paper-champion-direction-prior';

// Collection fixtures explicitly provide a healthy, empty PAPER history.
// Missing/empty production store responses are tested separately below.
function createCollector(...args: ConstructorParameters<typeof VpsForexSignalCollectorService>) {
  const original = args[6];
  args[6] = {
    ...original,
    query: async (sql: string, params: unknown[]) => {
      const rows = original ? await original.query(sql, params) : [];
      if (sql === PAPER_POST_LOSS_STATE_QUERY && Array.isArray(rows) && rows.length === 0) {
        return [
          {
            paper_post_loss_state_available: true,
            trade_id: null,
            close_reason: null,
            closed_at: null,
            reconfirmed: false,
          },
        ];
      }
      return rows;
    },
  } as any;
  return new VpsForexSignalCollectorService(...args);
}

describe('dynamic PAPER lot ceiling', () => {
  const base = {
    confidence: 0.68,
    metaProbability: 0.53,
    netExpectedR: 0.2,
    consensusPassed: 6,
    consensusRequired: 6,
    volatilityScore: 0.35,
  };

  it('starts the M5 dynamic PAPER target band at 0.20 lots', () => {
    expect(dynamicPaperLotUpperBound(base)).toEqual({ upperBound: 0.2, tier: 'BASE' });
  });

  it('permits larger PAPER ceilings only when confidence, meta probability, EV, consensus and volatility all qualify', () => {
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.71,
        metaProbability: 0.57,
        netExpectedR: 0.2,
      }),
    ).toEqual({ upperBound: 0.5, tier: 'STRONG' });
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.78,
        metaProbability: 0.64,
        netExpectedR: 0.31,
      }),
    ).toEqual({ upperBound: 1.0, tier: 'VERY_STRONG' });
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.9,
        metaProbability: 0.78,
        netExpectedR: 0.6,
        volatilityScore: 0.45,
      }),
    ).toEqual({ upperBound: 4.0, tier: 'ELITE' });
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.84,
        metaProbability: 0.7,
        netExpectedR: 0.45,
        volatilityScore: 0.5,
      }),
    ).toEqual({ upperBound: 2.0, tier: 'EXCEPTIONAL' });
  });

  it('does not upscale on confidence alone', () => {
    expect(
      dynamicPaperLotUpperBound({
        ...base,
        confidence: 0.91,
        metaProbability: 0.52,
        netExpectedR: 0.1,
        consensusPassed: 5,
      }),
    ).toEqual({ upperBound: 0.2, tier: 'BASE' });
  });
});

describe('PAPER opportunity scout model identity', () => {
  it('separates local-edge shadow-quarantine outcomes from earlier executable scout cohorts', () => {
    expect(paperOpportunityScoutModelVersion('irexpro-multimodel-ensemble-v1')).toBe(
      'external-provider/irexpro-multimodel-ensemble-v1/paper-opportunity-scout-v10-local-edge-shadow-quarantine-0.10-tier',
    );
  });
});

describe('PAPER scout product sizing floor', () => {
  it('keeps an executable scout at the 0.10 RESEARCH tier', () => {
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    expect(
      collector.adaptiveLotSizingFor({
        paperExecutionRoute: 'NORMAL_PAPER',
        paperOpportunityScout: {
          eligible: true,
          lotUpperBound: 0.1,
          sizingTier: 'RESEARCH',
          reason: 'CALIBRATED_OOD_SCOUT',
          mode: 'RECOVERY',
          targetWindowMinutes: 30,
          idleMinutes: 65,
        },
        candidate: {},
        planBEnsemble: {},
        ensembleGovernance: {},
      }),
    ).toEqual({ upperBound: 0.1, tier: 'RESEARCH' });
  });

  it('reduces only an eligible scout to 0.05 when its exact generation payoff is marginal', () => {
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    expect(
      collector.adaptiveLotSizingFor({
        paperExecutionRoute: 'NORMAL_PAPER',
        paperOpportunityScout: {
          eligible: true,
          lotUpperBound: 0.1,
          sizingTier: 'RESEARCH',
          reason: 'CALIBRATED_OOD_SCOUT',
          mode: 'ACTIVE',
          targetWindowMinutes: 30,
          idleMinutes: 45,
        },
        paperScoutRealisedPayoff: {
          state: 'REDUCED',
          executionAuthority: 'PAPER',
          maxLotCap: 0.05,
        },
        candidate: {},
        planBEnsemble: {},
        ensembleGovernance: {},
      }),
    ).toEqual({ upperBound: 0.05, tier: 'RESEARCH' });
  });
});

describe('PAPER local shadow-edge adaptive authority', () => {
  it('keeps mature local-pocket shadow evidence out of executable edge until transfer is validated', () => {
    expect(isPaperLocalShadowEdgeScoutReason('LOCAL_SHADOW_EDGE_SCOUT')).toBe(false);
    expect(
      executableNetExpectedR({
        paperExecutionRoute: 'NORMAL_PAPER',
        paperCalibratedIdleRecovery: null,
        ensembleGovernance: { netExpectedR: -0.48 },
        pairedDirectionReversal: { researchNetExpectedR: -0.2 },
        paperOpportunityScout: { reason: 'LOCAL_SHADOW_EDGE_SCOUT' },
        paperShadowLocalEdgePocket: { supported: true, averageNetR: 0.588 },
      } as any),
    ).toBeCloseTo(-0.48, 6);
  });

  it('keeps the three-vote high-conviction local pocket out of executable edge too', () => {
    expect(isPaperLocalShadowEdgeScoutReason('LOCAL_SHADOW_EDGE_CONSENSUS_SCOUT')).toBe(false);
    expect(isPaperLocalShadowEdgeScoutReason('LOCAL_EDGE_TRANSFER_SHADOW_ONLY')).toBe(false);
    expect(
      executableNetExpectedR({
        paperExecutionRoute: 'NORMAL_PAPER',
        paperCalibratedIdleRecovery: null,
        ensembleGovernance: { netExpectedR: -0.48 },
        pairedDirectionReversal: { researchNetExpectedR: -0.2 },
        paperOpportunityScout: { reason: 'LOCAL_SHADOW_EDGE_CONSENSUS_SCOUT' },
        paperShadowLocalEdgePocket: { supported: true, averageNetR: 0.588 },
      } as any),
    ).toBeCloseTo(-0.48, 6);
  });

  it('keeps provisional local-pocket evidence out of executable edge and route-override authority', () => {
    expect(isPaperLocalShadowEdgeScoutReason('PROVISIONAL_LOCAL_SHADOW_EDGE_SCOUT')).toBe(false);
    expect(isPaperLocalShadowEdgeScoutReason('PROVISIONAL_LOCAL_EDGE_SHADOW_ONLY')).toBe(false);
    expect(
      executableNetExpectedR({
        paperExecutionRoute: 'NORMAL_PAPER',
        paperCalibratedIdleRecovery: null,
        ensembleGovernance: { netExpectedR: 0.12 },
        pairedDirectionReversal: { researchNetExpectedR: -0.2 },
        paperOpportunityScout: { reason: 'PROVISIONAL_LOCAL_SHADOW_EDGE_SCOUT' },
        paperShadowLocalEdgePocket: { supported: false, averageNetR: 0.6 },
      } as any),
    ).toBeCloseTo(0.12, 6);

    expect(
      canHighConvictionLocalScoutOverrideRealisedRoute({
        fullSizePaperExecutionCandidate: false,
        scoutEligible: true,
        scoutReason: 'PROVISIONAL_LOCAL_SHADOW_EDGE_SCOUT',
        scoutLotUpperBound: 0.1,
        localPocketHighConviction: false,
        localPocketProvisional: true,
        structuralRouteEligible: true,
        pairSideEligible: true,
        realisedRouteEligible: false,
      }),
    ).toBe(false);
  });

  it('suppresses only the calibration negative-edge blocker when local pocket authority is explicit', () => {
    expect(adaptiveCalibrationExecutionBlockers(true, false)).toEqual([
      'ADAPTIVE_CALIBRATION_NEGATIVE_EDGE',
    ]);
    expect(adaptiveCalibrationExecutionBlockers(true, true)).toEqual([]);
    expect(adaptiveCalibrationExecutionBlockers(false, true)).toEqual([]);
  });

  it('does not let high-conviction local shadow evidence override realised-route demotion before transfer validation', () => {
    const base = {
      fullSizePaperExecutionCandidate: false,
      scoutEligible: true,
      scoutReason: 'LOCAL_SHADOW_EDGE_SCOUT' as const,
      scoutLotUpperBound: 0.1,
      localPocketHighConviction: true,
      structuralRouteEligible: true,
      pairSideEligible: true,
      realisedRouteEligible: false,
    };

    expect(canHighConvictionLocalScoutOverrideRealisedRoute(base)).toBe(false);
    expect(
      canHighConvictionLocalScoutOverrideRealisedRoute({
        ...base,
        scoutReason: 'CALIBRATED_OOD_SCOUT',
      }),
    ).toBe(false);
    expect(
      canHighConvictionLocalScoutOverrideRealisedRoute({
        ...base,
        localPocketHighConviction: false,
      }),
    ).toBe(false);
    expect(
      canHighConvictionLocalScoutOverrideRealisedRoute({
        ...base,
        structuralRouteEligible: false,
      }),
    ).toBe(false);
    expect(
      canHighConvictionLocalScoutOverrideRealisedRoute({
        ...base,
        pairSideEligible: false,
      }),
    ).toBe(false);
    expect(
      canHighConvictionLocalScoutOverrideRealisedRoute({
        ...base,
        scoutLotUpperBound: 0.2,
      }),
    ).toBe(false);
    expect(
      canHighConvictionLocalScoutOverrideRealisedRoute({
        ...base,
        fullSizePaperExecutionCandidate: true,
      }),
    ).toBe(false);
    expect(
      canHighConvictionLocalScoutOverrideRealisedRoute({
        ...base,
        realisedRouteEligible: true,
      }),
    ).toBe(false);
  });
});

describe('calibrated idle recovery scanner plumbing', () => {
  it('ranks an eligible idle-recovery research candidate by calibrated edge', () => {
    expect(
      executableNetExpectedR({
        paperExecutionRoute: 'PAPER_RESEARCH_THROUGHPUT',
        paperCalibratedIdleRecovery: {
          eligible: true,
          calibratedNetExpectedR: 0.173,
        },
        ensembleGovernance: { netExpectedR: -0.114 },
        pairedDirectionReversal: { researchNetExpectedR: 0.31 },
      } as any),
    ).toBeCloseTo(0.173, 6);
  });

  it('caps idle-recovery research at 0.05 lots', () => {
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    expect(
      collector.adaptiveLotSizingFor({
        paperExecutionRoute: 'PAPER_RESEARCH_THROUGHPUT',
        paperCalibratedIdleRecovery: { eligible: true, lotCap: 0.05 },
        candidate: {},
        planBEnsemble: {},
        ensembleGovernance: {},
      }),
    ).toEqual({ upperBound: 0.05, tier: 'RESEARCH' });
  });

  it('derives idle minutes from the most recent signal-driven PAPER trade', async () => {
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    const query = jest
      .fn()
      .mockResolvedValue([{ last_opened_at: new Date('2026-10-20T12:00:00.000Z') }]);
    collector.dataSource = { query };
    await expect(
      collector.loadPaperIdleState('user-1', 'conn-1', new Date('2026-10-20T17:00:00.000Z')),
    ).resolves.toMatchObject({
      available: true,
      lastOpenedAt: new Date('2026-10-20T12:00:00.000Z'),
      idleMinutes: 300,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not let a newer M1 trade reset the M5 participation idle clock', async () => {
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("ti.timeframe = 'M5'")) {
        return [{ last_opened_at: new Date('2026-10-20T12:00:00.000Z') }];
      }
      return [{ last_opened_at: new Date('2026-10-20T16:55:00.000Z') }];
    });
    collector.dataSource = { query };

    await expect(
      collector.loadPaperIdleState('user-1', 'conn-1', new Date('2026-10-20T17:00:00.000Z')),
    ).resolves.toMatchObject({
      available: true,
      lastOpenedAt: new Date('2026-10-20T12:00:00.000Z'),
      idleMinutes: 300,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ti.timeframe = 'M5'"), [
      'user-1',
      'conn-1',
    ]);
  });

  it('derives idle minutes from PAPER session start when no signal trade exists yet', async () => {
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    const query = jest.fn().mockResolvedValue([{ last_opened_at: null }]);
    collector.dataSource = { query };
    await expect(
      collector.loadPaperIdleState(
        'user-1',
        'conn-1',
        new Date('2026-10-20T17:00:00.000Z'),
        new Date('2026-10-20T16:00:00.000Z'),
      ),
    ).resolves.toEqual({
      available: true,
      lastOpenedAt: null,
      idleMinutes: 60,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

const PAIRS = [
  ['EURUSD', 'EUR/USD'],
  ['GBPUSD', 'GBP/USD'],
  ['USDJPY', 'USD/JPY'],
  ['AUDUSD', 'AUD/USD'],
  ['USDCAD', 'USD/CAD'],
  ['USDCHF', 'USD/CHF'],
] as const;

function trendCandles(base = 1.1, digits = 5, drift = 0.00001, amp = 0.0001, count = 360) {
  const latestOpen = Math.floor(Date.now() / 300000) * 300000 - 300000;
  return Array.from({ length: count }, (_, i) => {
    const close = base + i * drift + Math.sin(i / 2) * amp;
    const range = base > 10 ? 0.01 : 0.00008;
    return {
      timestamp: new Date(latestOpen - (count - 1 - i) * 300000),
      open: close.toFixed(digits),
      high: (close + range).toFixed(digits),
      low: (close - range).toFixed(digits),
      close: close.toFixed(digits),
    };
  });
}

function flatCandles(base: number, digits: number) {
  const latestOpen = Math.floor(Date.now() / 300000) * 300000 - 300000;
  return Array.from({ length: 360 }, (_, i) => {
    const close = base + Math.sin(i / 2) * (base > 10 ? 0.005 : 0.00003);
    const range = base > 10 ? 0.01 : 0.00008;
    return {
      timestamp: new Date(latestOpen - (359 - i) * 300000),
      open: close.toFixed(digits),
      high: (close + range).toFixed(digits),
      low: (close - range).toFixed(digits),
      close: close.toFixed(digits),
    };
  });
}

function payload() {
  const data: Record<string, any> = {};
  for (const [instrument, provider] of PAIRS) {
    const isEur = instrument === 'EURUSD';
    const base =
      instrument === 'USDJPY'
        ? 157
        : instrument === 'GBPUSD'
          ? 1.34
          : instrument === 'USDCAD'
            ? 1.37
            : instrument === 'USDCHF'
              ? 0.8
              : instrument === 'AUDUSD'
                ? 0.66
                : 1.1;
    const digits = instrument === 'USDJPY' ? 3 : 5;
    const rows = isEur ? trendCandles(base, digits) : flatCandles(base, digits);
    data[provider] = {
      status: 'ok',
      meta: { symbol: provider },
      values: rows.map((row) => ({
        datetime: row.timestamp.toISOString().slice(0, 19).replace('T', ' '),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })),
    };
  }
  return data;
}

function allTrendPayload() {
  const data: Record<string, any> = {};
  for (const [instrument, provider] of PAIRS) {
    const base =
      instrument === 'USDJPY'
        ? 157
        : instrument === 'GBPUSD'
          ? 1.34
          : instrument === 'USDCAD'
            ? 1.37
            : instrument === 'USDCHF'
              ? 0.8
              : instrument === 'AUDUSD'
                ? 0.66
                : 1.1;
    const digits = instrument === 'USDJPY' ? 3 : 5;
    const rows =
      instrument === 'USDJPY'
        ? trendCandles(base, digits, 0.001, 0.01)
        : trendCandles(base, digits);
    data[provider] = {
      status: 'ok',
      meta: { symbol: provider },
      values: rows.map((row) => ({
        datetime: row.timestamp.toISOString().slice(0, 19).replace('T', ' '),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })),
    };
  }
  return data;
}

function aiEngineClientMock() {
  return {
    isSchedulerIntegrationEnabled: jest.fn().mockReturnValue(true),
    notifySessionStopped: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function config(values: Record<string, unknown>) {
  return {
    get: jest.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  } as unknown as ConfigService;
}

function installAlignedFastMarkMirror(live: LivePaperMarketDataService): void {
  jest
    .spyOn(live, 'getMarkQuote')
    .mockImplementation((instrument, _streamAge, _fallbackAge, connectionId) => {
      const execution = live.getQuote(instrument, 20 * 60_000, connectionId);
      return {
        ...execution,
        timestamp: new Date(),
        source: 'STREAM',
        streamProvider: 'DERIV',
      };
    });
}

describe('PAPER entry market alignment', () => {
  const base = {
    direction: 'BUY' as const,
    candidateBarTime: new Date('2026-10-20T08:45:00.000Z'),
    scanStartedAt: new Date('2026-10-20T08:50:01.000Z'),
    evaluatedAt: new Date('2026-10-20T08:50:22.000Z'),
    stopLoss: 158.116,
    executionQuote: {
      bid: '158.165',
      ask: '158.177',
      timestamp: new Date('2026-10-20T08:50:00.000Z'),
      source: 'REST_M5' as const,
    },
    fastMark: {
      bid: '158.160',
      ask: '158.170',
      timestamp: new Date('2026-10-20T08:50:21.000Z'),
      source: 'STREAM' as const,
      streamProvider: 'DERIV' as const,
    },
  };

  it('allows a fresh fast mark when little of the planned stop distance has been consumed', () => {
    expect(
      evaluatePaperEntryMarketAlignment({
        ...base,
        fastMark: { ...base.fastMark, bid: '158.170', ask: '158.180' },
      }),
    ).toMatchObject({ eligible: true, reason: 'ALIGNED' });
  });

  it('keeps a scan-snapshot-fresh candidate eligible when scoring crosses the next M5 boundary', () => {
    expect(
      evaluatePaperEntryMarketAlignment({
        ...base,
        candidateBarTime: new Date('2026-10-26T17:40:00.000Z'),
        scanStartedAt: new Date('2026-10-26T17:49:42.000Z'),
        evaluatedAt: new Date('2026-10-26T17:50:29.000Z'),
        executionQuote: {
          bid: '0.65880',
          ask: '0.65890',
          timestamp: new Date('2026-10-26T17:45:00.000Z'),
          source: 'REST_M5',
        },
        fastMark: {
          bid: '0.65888',
          ask: '0.65898',
          timestamp: new Date('2026-10-26T17:50:28.000Z'),
          source: 'STREAM',
          streamProvider: 'DERIV',
        },
        stopLoss: 0.6579,
      }),
    ).toMatchObject({ eligible: true, reason: 'ALIGNED' });
  });

  it('blocks a candidate that is not the latest fully closed M5 bar', () => {
    expect(
      evaluatePaperEntryMarketAlignment({
        ...base,
        candidateBarTime: new Date('2026-10-20T08:30:00.000Z'),
      }),
    ).toMatchObject({ eligible: false, reason: 'STALE_M5_CANDIDATE' });
  });

  it('blocks when the execution quote is not bound to the candidate close boundary', () => {
    expect(
      evaluatePaperEntryMarketAlignment({
        ...base,
        executionQuote: {
          ...base.executionQuote,
          timestamp: new Date('2026-10-20T08:45:00.000Z'),
        },
      }),
    ).toMatchObject({ eligible: false, reason: 'EXECUTION_SNAPSHOT_MISMATCH' });
  });

  it('requires an independent fresh fast mark instead of falling back to REST M5', () => {
    expect(
      evaluatePaperEntryMarketAlignment({
        ...base,
        fastMark: {
          ...base.fastMark,
          source: 'REST_M5',
          streamProvider: undefined,
        },
      }),
    ).toMatchObject({ eligible: false, reason: 'FAST_MARK_UNAVAILABLE' });
  });

  it('blocks BUY when the live bid is already through the planned stop', () => {
    expect(
      evaluatePaperEntryMarketAlignment({
        ...base,
        fastMark: { ...base.fastMark, bid: '158.110', ask: '158.120' },
      }),
    ).toMatchObject({ eligible: false, reason: 'LIVE_STOP_ALREADY_BREACHED' });
  });

  it('blocks SELL when the live ask is already through the planned stop', () => {
    expect(
      evaluatePaperEntryMarketAlignment({
        direction: 'SELL',
        candidateBarTime: new Date('2026-10-20T06:00:00.000Z'),
        scanStartedAt: new Date('2026-10-20T06:05:01.000Z'),
        evaluatedAt: new Date('2026-10-20T06:05:19.000Z'),
        stopLoss: 158.195,
        executionQuote: {
          bid: '158.135',
          ask: '158.145',
          timestamp: new Date('2026-10-20T06:05:00.000Z'),
          source: 'REST_M5',
        },
        fastMark: {
          bid: '158.192',
          ask: '158.202',
          timestamp: new Date('2026-10-20T06:05:18.000Z'),
          source: 'STREAM',
          streamProvider: 'DERIV',
        },
      }),
    ).toMatchObject({ eligible: false, reason: 'LIVE_STOP_ALREADY_BREACHED' });
  });

  it('blocks an entry after at least 25 percent of its stop budget has already been consumed', () => {
    expect(
      evaluatePaperEntryMarketAlignment({
        ...base,
        fastMark: { ...base.fastMark, bid: '158.147', ask: '158.157' },
      }),
    ).toMatchObject({
      eligible: false,
      reason: 'ADVERSE_MOVE_CONSUMED_STOP_BUDGET',
    });
  });
});

describe('multi-model PAPER execution gate', () => {
  it('allows an admitted setup when PAPER governance passes even while promotion remains separate', () => {
    expect(
      canExecuteMultiModelPaper({ paperAdmitted: true }, { paperExecutionEligible: true }),
    ).toBe(true);
  });

  it('fails closed when model admission or PAPER governance fails', () => {
    expect(
      canExecuteMultiModelPaper({ paperAdmitted: false }, { paperExecutionEligible: true }),
    ).toBe(false);
    expect(
      canExecuteMultiModelPaper({ paperAdmitted: true }, { paperExecutionEligible: false }),
    ).toBe(false);
  });
});

describe('paired reversal route precedence', () => {
  it('keeps existing execution routes authoritative over paired reversal research on the same pair', () => {
    const existingRoute = {
      candidate: { direction: 'BUY' },
      paperExecutionRoute: 'NORMAL_PAPER',
      netExpectedR: 0.12,
    } as const;
    const pairedResearch = {
      candidate: { direction: 'SELL' },
      paperExecutionRoute: 'PAIRED_REVERSAL_RESEARCH',
      netExpectedR: 0.45,
    } as const;

    expect(prioritizeCounterfactualExecutionRoutes([existingRoute, pairedResearch])).toEqual([
      existingRoute,
    ]);
  });
});

describe('VpsForexSignalCollectorService', () => {
  it('collects every closed M5 slot across the FX 24x5 market week', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const isCollectionSlot = (value: string) =>
      (collector as any).isCollectionSlot(new Date(value)) as boolean;
    const nextEligible = (value: string) =>
      ((collector as any).nextEligibleScanAt(new Date(value)) as Date).toISOString();

    expect(isCollectionSlot('2026-10-05T10:00:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-05T10:05:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-05T10:10:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-05T10:03:00.000Z')).toBe(true);

    expect(isCollectionSlot('2026-10-10T12:00:00.000Z')).toBe(false);
    expect(isCollectionSlot('2026-10-11T20:55:00.000Z')).toBe(false);
    expect(isCollectionSlot('2026-10-11T21:00:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-09T20:55:00.000Z')).toBe(true);
    expect(isCollectionSlot('2026-10-09T21:00:00.000Z')).toBe(false);

    expect(nextEligible('2026-10-05T10:03:00.000Z')).toBe('2026-10-05T10:05:00.000Z');
    expect(nextEligible('2026-10-05T10:05:00.000Z')).toBe('2026-10-05T10:10:00.000Z');
    expect(nextEligible('2026-10-11T20:58:00.000Z')).toBe('2026-10-11T21:00:00.000Z');
    expect(nextEligible('2026-10-09T20:58:00.000Z')).toBe('2026-10-11T21:00:00.000Z');

    const status = await collector.getStatus('user-1');
    expect(status.cadenceMinutes).toBe(5);
    expect(status.timeframe).toBe('M5');
    expect(status.skippedUtcHours).toEqual([]);
  });

  it('builds one read-only pair-side reliability snapshot for all 12 sleeves', async () => {
    const outcome = (status: 'WIN' | 'LOSS', evaluatedAt: string, netR: number) => ({
      evaluated_at: new Date(evaluatedAt),
      instrument: 'USDJPY',
      direction: 'BUY',
      outcome: {
        version: ENSEMBLE_OUTCOME_MODEL_VERSION,
        status,
        resolvedAt: new Date(new Date(evaluatedAt).getTime() + 60_000).toISOString(),
        barsObserved: 1,
        exitPrice: 1,
        grossR: netR,
        netR,
        reason: status === 'WIN' ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
        postEntryTelemetry: null,
      },
    });
    const rows = Array.from({ length: 8 }, (_unused, index) =>
      outcome('WIN', `2026-10-09T${String(10 + index).padStart(2, '0')}:00:00.000Z`, 1.2),
    );
    const dataSource = { query: jest.fn().mockResolvedValue(rows) };
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      dataSource as any,
    );

    const snapshot = await (collector as any).loadPaperTrendPairSideReliabilitySnapshot(
      'user-1',
      'conn-1',
    );

    const cachedSnapshot = await (collector as any).loadPaperTrendPairSideReliabilitySnapshot(
      'user-1',
      'conn-1',
    );

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [snapshotSql, snapshotParams] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(snapshotSql).toContain("components->'outcome'->>'version' = $6");
    expect(snapshotParams[5]).toBe(ENSEMBLE_OUTCOME_MODEL_VERSION);
    expect(cachedSnapshot).toBe(snapshot);
    expect(snapshot).toHaveLength(12);
    expect(
      snapshot.find((row: any) => row.instrument === 'USDJPY' && row.direction === 'BUY'),
    ).toMatchObject({
      state: 'HEALTHY',
      episodes: 8,
      fullSizeEligible: true,
      researchFallbackRequested: false,
      reason: 'PAIR_SIDE_HEALTHY',
    });
    expect(
      snapshot.find((row: any) => row.instrument === 'EURUSD' && row.direction === 'SELL'),
    ).toMatchObject({
      state: 'COLLECTING',
      episodes: 0,
      fullSizeEligible: true,
      researchFallbackRequested: false,
      reason: 'INSUFFICIENT_PAIR_SIDE_EVIDENCE',
    });
  });

  it('builds and caches a 12-sleeve champion direction prior snapshot from the latest 100 champion trades', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          instrument: 'GBPUSD',
          direction: 'SELL',
          trades: 12,
          gross_profit: '27.8',
          gross_loss: '20.4',
          net_pnl: '7.4',
        },
        {
          instrument: 'EURUSD',
          direction: 'SELL',
          trades: 11,
          gross_profit: '20.4',
          gross_loss: '39.5',
          net_pnl: '-19.1',
        },
      ]),
    };
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      dataSource as any,
    );

    const snapshot = await (collector as any).loadPaperChampionDirectionPriorSnapshot(
      'user-1',
      'conn-1',
    );
    const cached = await (collector as any).loadPaperChampionDirectionPriorSnapshot(
      'user-1',
      'conn-1',
    );

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('LIMIT 100');
    expect(params).toEqual(
      expect.arrayContaining([
        'user-1',
        'conn-1',
        'external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1',
      ]),
    );
    expect(cached).toBe(snapshot);
    expect(snapshot).toHaveLength(12);
    expect(
      snapshot.find((row: any) => row.instrument === 'GBPUSD' && row.direction === 'SELL'),
    ).toMatchObject({
      supported: true,
      reason: 'CHAMPION_DIRECTION_SUPPORTED',
      trades: 12,
      netPnl: 7.4,
    });
    expect(
      snapshot.find((row: any) => row.instrument === 'EURUSD' && row.direction === 'SELL'),
    ).toMatchObject({
      supported: false,
      reason: 'CHAMPION_DIRECTION_NET_PNL_NOT_POSITIVE',
    });
    expect(
      snapshot.find((row: any) => row.instrument === 'USDJPY' && row.direction === 'BUY'),
    ).toMatchObject({
      supported: false,
      reason: 'INSUFFICIENT_CHAMPION_DIRECTION_EVIDENCE',
      trades: 0,
    });
  });

  it('fails closed to no champion direction prior when the snapshot query is unavailable', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query: jest.fn().mockRejectedValue(new Error('db unavailable')) } as any,
    );

    await expect(
      (collector as any).loadPaperChampionDirectionPriorSnapshot('user-1', 'conn-1'),
    ).resolves.toEqual([]);
  });

  it('excludes an incomplete H4 bucket from causal higher-timeframe context', () => {
    const candles = Array.from({ length: 8 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 9, 16, 12, index * 5, 0)),
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
    }));
    expect(aggregateCompletedCandles(candles, 240)).toHaveLength(0);

    const fullH4 = Array.from({ length: 48 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 9, 16, 12, index * 5, 0)),
      open: '1.10000',
      high: '1.10100',
      low: '1.09900',
      close: '1.10050',
    }));
    const completed = aggregateCompletedCandles(fullH4, 240);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.timestamp.toISOString()).toBe('2026-10-16T12:00:00.000Z');

    const missingOneBar = fullH4.filter((_, index) => index !== 17);
    expect(aggregateCompletedCandles(missingOneBar, 240)).toHaveLength(0);
  });

  it('adds causal H4 alignment only when enough fully closed H4 evidence exists', () => {
    const longHistory = trendCandles(1.1, 5, 0.00001, 0.0001, 500);
    const candidates = buildDirectionalCandidates('EURUSD', longHistory);
    const buy = candidates.find((candidate) => candidate.direction === 'BUY')!;
    const sell = candidates.find((candidate) => candidate.direction === 'SELL')!;
    expect(buy.h4ContextAvailable).toBe(true);
    expect(sell.h4ContextAvailable).toBe(true);
    expect(buy.h4ClosedBarCount).toBeGreaterThanOrEqual(9);
    expect(buy.h4Alignment!).toBeGreaterThan(sell.h4Alignment!);

    const shortHistory = buildDirectionalCandidates('EURUSD', trendCandles());
    expect(shortHistory.every((candidate) => candidate.h4ContextAvailable === false)).toBe(true);
    expect(shortHistory.every((candidate) => candidate.h4Alignment === 0)).toBe(true);
  });

  it('builds BUY and SELL counterfactuals from the same market snapshot', () => {
    const candidates = buildDirectionalCandidates('EURUSD', trendCandles());
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.direction))).toEqual(
      new Set(['BUY', 'SELL']),
    );
    const buy = candidates.find((candidate) => candidate.direction === 'BUY')!;
    const sell = candidates.find((candidate) => candidate.direction === 'SELL')!;
    expect(buy.entry).toBeCloseTo(sell.entry, 10);
    expect(buy.barTime.toISOString()).toBe(sell.barTime.toISOString());
    expect(buy.emaSeparation).toBeGreaterThan(sell.emaSeparation);
    expect(buy.mtfStrength).toBeGreaterThan(sell.mtfStrength);
  });

  it('keeps a valid extended market snapshot visible to downstream AI governance', () => {
    const candles = trendCandles();
    const last = candles[candles.length - 1]!;
    const jumpedClose = Number(last.close) + 0.004;
    candles[candles.length - 1] = {
      ...last,
      open: jumpedClose.toFixed(5),
      high: (jumpedClose + 0.00008).toFixed(5),
      low: (jumpedClose - 0.00008).toFixed(5),
      close: jumpedClose.toFixed(5),
    };

    const candidates = buildDirectionalCandidates('EURUSD', candles);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.extensionAtr > 1.5)).toBe(true);
  });

  it('keeps a valid high-volatility snapshot visible to downstream AI governance', () => {
    const candles = trendCandles().map((candle) => {
      const close = Number(candle.close);
      return {
        ...candle,
        high: (close + 0.0012).toFixed(5),
        low: (close - 0.0012).toFixed(5),
      };
    });

    const candidates = buildDirectionalCandidates('EURUSD', candles);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.volatilityScore >= 0.75)).toBe(true);
  });

  it('rescues to the opposite direction when only that counterfactual is executable', () => {
    const [buy, sell] = buildDirectionalCandidates('EURUSD', trendCandles());
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    const byDirection = new Map([buy, sell].map((candidate) => [candidate.direction, candidate]));
    const selection = selectCounterfactualExecutionCandidate([
      {
        candidate: byDirection.get('BUY')!,
        paperExecutionEligible: false,
        netExpectedR: -0.05,
        estimatedExecutionCostR: 0.04,
      },
      {
        candidate: byDirection.get('SELL')!,
        paperExecutionEligible: true,
        netExpectedR: 0.16,
        estimatedExecutionCostR: 0.04,
      },
    ]);
    expect(selection.reason).toBe('SINGLE_ELIGIBLE_DIRECTION');
    expect(selection.selected?.candidate.direction).toBe('SELL');
  });

  it('abstains when both directions pass but their net edges are inside execution-cost uncertainty', () => {
    const [buy, sell] = buildDirectionalCandidates('EURUSD', trendCandles());
    const selection = selectCounterfactualExecutionCandidate([
      {
        candidate: buy!,
        paperExecutionEligible: true,
        netExpectedR: 0.14,
        estimatedExecutionCostR: 0.08,
      },
      {
        candidate: sell!,
        paperExecutionEligible: true,
        netExpectedR: 0.13,
        estimatedExecutionCostR: 0.08,
      },
    ]);
    expect(selection.reason).toBe('AMBIGUOUS_DUAL_EDGE');
    expect(selection.selected).toBeNull();
    expect(selection.requiredEdgeMarginR).toBeGreaterThanOrEqual(0.02);
  });

  it('builds a deterministic qualifying trend candidate without claiming model qualification', () => {
    const candidate = buildCandidate('EURUSD', trendCandles());
    expect(candidate).not.toBeNull();
    expect(candidate!.direction).toBe('BUY');
    expect(candidate!.confidence).toBeGreaterThanOrEqual(0.64);
    expect(candidate!.confidence).toBeLessThanOrEqual(0.8);
    expect(candidate!.takeProfit).toBeGreaterThan(candidate!.entry);
    expect(candidate!.stopLoss).toBeLessThan(candidate!.entry);
    const stopPips = Math.abs(candidate!.entry - candidate!.stopLoss) / 0.0001;
    const rewardRisk =
      Math.abs(candidate!.takeProfit - candidate!.entry) /
      Math.abs(candidate!.entry - candidate!.stopLoss);
    expect(stopPips).toBeGreaterThanOrEqual(5);
    expect(rewardRisk).toBeCloseTo(2.5 / 1.5, 6);
  });

  it('classifies repeated unchanged setup as stale telemetry while detecting fresh same-side evidence', () => {
    const candidate = buildCandidate('EURUSD', trendCandles());
    expect(candidate).not.toBeNull();
    const current = candidate!;
    const previous = {
      direction: current.direction,
      confidence: current.confidence,
      entry: current.entry,
      atr: current.atr,
      barTimeMs: current.barTime.getTime() - 10 * 60_000,
    };

    expect(isFreshOpportunity(current, previous)).toBe(false);
    expect(
      isFreshOpportunity(
        {
          ...current,
          entry:
            current.direction === 'BUY'
              ? current.entry + current.atr * 0.6
              : current.entry - current.atr * 0.6,
        },
        previous,
      ),
    ).toBe(true);
    expect(
      isFreshOpportunity({ ...current, confidence: current.confidence + 0.03 }, previous),
    ).toBe(true);
  });

  it('restores freshness and last ensemble state from the durable shadow ledger', async () => {
    const current = buildCandidate('EURUSD', trendCandles());
    expect(current).not.toBeNull();

    const query = jest.fn().mockResolvedValue([
      {
        instrument: 'EURUSD',
        direction: current!.direction,
        entry_price: String(current!.entry),
        atr: String(current!.atr),
        confidence: String(current!.confidence),
        market_bar_time: current!.barTime,
        evaluated_at: new Date(current!.barTime.getTime() + 5 * 60_000),
        admitted: false,
        ensemble_score: '0.41250000',
        meta_probability: '0.40125000',
        expected_r: '0.07000000',
        consensus_passed: 4,
        consensus_required: 6,
        regime: 'TREND_WEAK',
        reasons: ['REGIME_TREND_WEAK'],
      },
    ]);

    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await (collector as any).restorePublishedOpportunities('user-1', 'conn-1');
    const restored = (collector as any).lastPublishedOpportunity.get('EURUSD');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('model_version = $4'), [
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      PlanBEnsembleModule.PLAN_B_ACTIVE_MODEL_POLICY_VERSION,
    ]);
    expect(restored).toBeDefined();
    expect(restored.direction).toBe(current!.direction);
    expect(restored.confidence).toBeCloseTo(current!.confidence, 10);
    expect(restored.entry).toBeCloseTo(current!.entry, 10);
    expect(restored.atr).toBeCloseTo(current!.atr, 10);
    expect(isFreshOpportunity(current!, restored)).toBe(false);
    expect((collector as any).lastEnsembleDecision).toEqual(
      expect.objectContaining({
        instrument: 'EURUSD',
        direction: current!.direction,
        admitted: false,
        candidateConfidence: current!.confidence,
        ensembleScore: 0.4125,
        metaProbability: 0.40125,
        expectedR: 0.07,
        consensusPassed: 4,
        consensusRequired: 6,
        regime: 'TREND_WEAK',
        reasons: ['REGIME_TREND_WEAK'],
      }),
    );
  });

  it('isolates campaign statistics to the current model policy version', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await (collector as any).loadEnsembleCampaignStatus('user-1', 'conn-1');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('model_version = $4'), [
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      PlanBEnsembleModule.PLAN_B_ACTIVE_MODEL_POLICY_VERSION,
    ]);
  });

  it('resolves rejected counterfactual outcomes instead of learning only from admitted decisions', async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT') && String(sql).includes('ensemble_shadow_decisions')) {
        return [
          {
            id: 'paper-only-decision',
            instrument: 'EURUSD',
            direction: 'SELL',
            market_bar_time: new Date('2026-10-05T10:00:00.000Z'),
            evaluated_at: new Date('2026-10-05T10:00:30.000Z'),
            entry_price: '1.1000',
            components: {
              stopLoss: 1.1005,
              takeProfit: 1.099,
              governance: {
                paperExecutionEligible: false,
                estimatedExecutionCostR: 0.1,
                executionSpreadEvidence: { spreadPrice: 0.00004 },
              },
            },
          },
        ];
      }
      return [];
    });
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );
    (collector as any).lastMarketDataAuthority = 'METAAPI_BROKER_FALLBACK';
    const candles = new Map([
      [
        'EURUSD',
        [
          {
            timestamp: new Date('2026-10-05T10:05:00.000Z'),
            open: '1.1000',
            high: '1.10047',
            low: '1.0995',
            close: '1.1001',
          },
        ],
      ],
    ]);

    await (collector as any).resolvePendingEnsembleShadowOutcomes('user-1', 'conn-1', candles);

    const selectSql = String(query.mock.calls[0][0]);
    expect(selectSql).toContain('market_bar_time >= $4');
    expect(selectSql).toContain('model_version = ANY($5::text[])');
    expect(selectSql).not.toContain('admitted = true');
    expect(selectSql).not.toContain('paperExecutionEligible');
    expect(selectSql).not.toContain('highConvictionOverlay');
    expect(selectSql).not.toContain('trendPersistenceShadow');
    const updateCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE trading.ensemble_shadow_decisions'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]?.[0]).toBe('paper-only-decision');
    expect(JSON.parse(updateCall?.[1]?.[1] as string)).toMatchObject({
      status: 'LOSS',
      reason: 'STOP_LOSS_HIT',
    });
  });

  it('loads rolling broker P90 spread evidence from sampled MetaApi quotes', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        sample_count: 42,
        spread_price: '0.00001000',
        latest_sample_at: '2026-10-07T11:59:00.000Z',
      },
    ]);
    const collector = createCollector(
      config({
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-source-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const evaluatedAt = new Date('2026-10-07T12:00:00.000Z');
    const evidence = await (collector as any).loadExecutionSpreadEvidence('EURUSD', evaluatedAt);

    expect(evidence).toEqual({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 42,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: '2026-10-07T11:59:00.000Z',
    });
    expect(String(query.mock.calls[0][0])).toContain('percentile_cont(0.90)');
    expect(String(query.mock.calls[0][0])).toContain('market_data.provider_quote_candles');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'metaapi-source-1',
      'EURUSD',
      evaluatedAt.toISOString(),
    ]);
  });

  it('loads same-session historical broker P95 for PAPER spread calibration shadow', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        sample_count: 240,
        p95_spread_price: '0.00002000',
        latest_sample_at: '2026-10-13T15:28:00.000Z',
      },
    ]);
    const collector = createCollector(
      config({
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-source-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const evaluatedAt = new Date('2026-10-15T14:00:00.000Z');
    const history = await (collector as any).loadPaperSpreadCalibrationHistory(
      'AUDUSD',
      evaluatedAt,
    );

    expect(history).toEqual({ sampleCount: 240, p95SpreadPrice: 0.00002 });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('percentile_cont(0.95)');
    expect(sql).toContain("interval '21 days'");
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(sql).toContain('market_data.provider_quote_candles');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'metaapi-source-1',
      'AUDUSD',
      evaluatedAt.toISOString(),
      'NEW_YORK',
    ]);
  });

  it('builds sleeve qualification evidence from the actual PAPER execution policy cohort', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await (collector as any).loadEnsembleSleeveEvidence('user-1', 'conn-1', 'USDJPY', 'BUY');

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('paperExecutionEligible');
    expect(sql).not.toContain('AND admitted = true');
    expect(sql).toContain('model_version = $6');
    expect(sql).toContain("components->'outcome'->>'version' = $7");
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      'USDJPY',
      'BUY',
      PlanBEnsembleModule.PLAN_B_ACTIVE_MODEL_POLICY_VERSION,
      ENSEMBLE_OUTCOME_MODEL_VERSION,
    ]);
  });

  it('refreshes all six live PAPER feeds but freezes legacy v7 execution during multi-model cutover', async () => {
    const live = new LivePaperMarketDataService();
    expect(live.isLiveConnection('conn-1')).toBe(false);
    const receiveSignal = jest
      .fn()
      .mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED', signalId: 'x' });
    const heartbeat = jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      { getCurrentPriceForConnection: heartbeat } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() });

    await collector.collectOnce(fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'symbol=EUR%2FUSD%2CGBP%2FUSD%2CUSD%2FJPY',
    );
    expect(heartbeat).toHaveBeenCalledTimes(6);
    expect(live.isLiveConnection('conn-1')).toBe(true);
    expect(receiveSignal).not.toHaveBeenCalled();
    expect(shadowQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO trading.ensemble_shadow_decisions'),
      expect.arrayContaining(['user-1', 'session-1', 'conn-1', 'irexpro-multimodel-ensemble-v1']),
    );
    expect((collector as any).lastEnsembleDecision.evaluatedAt).toBeInstanceOf(Date);
    expect((collector as any).lastEnsembleDecision.instrument).toBe('EURUSD');
    expect((collector as any).lastEnsembleDecision.consensusRequired).toBeGreaterThan(0);
    expect(live.getOHLCV('EURUSD', 'M5', 70, 'conn-1')).toHaveLength(70);
  });

  it.each([-1, 1])(
    'sends raw market momentum to both model directions for a %s price impulse while preserving aligned telemetry',
    async (impulseSign) => {
      const live = new LivePaperMarketDataService();
      const shadowQuery = jest.fn().mockResolvedValue([]);
      const modelSpy = jest.spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow');
      const governanceSpy = jest.spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance');
      const collector = createCollector(
        config({
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.apiKey': 'fixture-key-123456',
          'vpsForexScanner.userId': 'user-1',
          'vpsForexScanner.brokerConnectionId': 'conn-1',
        }),
        { receiveSignal: jest.fn() } as unknown as AiSignalService,
        {
          getActiveSession: jest.fn().mockResolvedValue({
            id: 'session-1',
            brokerConnectionId: 'conn-1',
            executionMode: ExecutionMode.PAPER_ONLY,
          }),
        } as unknown as ExecutionService,
        {
          getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        } as unknown as BrokerService,
        live,
        aiEngineClientMock(),
        { query: shadowQuery } as any,
      );
      const market = allTrendPayload();
      const latest = market['EUR/USD'].values[359];
      const previous = market['EUR/USD'].values[358];
      const close = Number(previous.close) + impulseSign * 0.00012;
      latest.close = close.toFixed(5);
      latest.open = latest.close;
      latest.high = (close + 0.00008).toFixed(5);
      latest.low = (close - 0.00008).toFixed(5);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => market,
      });

      try {
        await collector.collectOnce(fetchMock as unknown as typeof fetch);
        const candles = live.getOHLCV('EURUSD', 'M5', 360, 'conn-1');
        const candidates = buildDirectionalCandidates('EURUSD', candles);
        const expectedRawMomentum =
          (Number(latest.close) - Number(previous.close)) / candidates[0]!.atr;
        expect(Math.sign(expectedRawMomentum)).toBe(impulseSign);

        for (const direction of ['BUY', 'SELL'] as const) {
          const modelInput = modelSpy.mock.calls.find(
            ([input]) => input.instrument === 'EURUSD' && input.direction === direction,
          )?.[0];
          const governanceInput = governanceSpy.mock.calls.find(
            ([input]) => input.instrument === 'EURUSD' && input.direction === direction,
          )?.[0];
          expect(modelInput).toBeDefined();
          expect(governanceInput).toBeDefined();
          expect(modelInput!.shortHorizonMomentumAtr).toBeCloseTo(expectedRawMomentum, 10);
          expect(governanceInput!.shortHorizonMomentumAtr).toBeCloseTo(expectedRawMomentum, 10);
          if (direction === 'SELL') {
            const reversalScore = PlanBEnsembleModule.scorePlanBMultimodelShadow({
              ...modelInput!,
              confidence: 0.66,
              extensionAtr: 0.8,
              volatilityScore: 0.1,
              emaSeparation: 0.15,
              mtfStrength: 0.05,
              rsi14: 42,
              scanTime: new Date('2026-10-12T14:05:00.000Z'),
            });
            expect(reversalScore.regime).toBe(
              impulseSign === -1 ? 'REVERSAL_CONFIRMED' : 'TREND_WEAK',
            );
            expect(reversalScore.paperAdmitted).toBe(impulseSign === -1);
          }
          const ledgerCall = shadowQuery.mock.calls.find(
            ([sql, params]) =>
              String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions') &&
              params[6] === 'EURUSD' &&
              params[7] === direction,
          );
          expect(ledgerCall).toBeDefined();
          const components = JSON.parse(String(ledgerCall![1][23]));
          const expectedAlignedMomentum = (direction === 'BUY' ? 1 : -1) * expectedRawMomentum;
          expect(components.shortHorizonMomentumAtr).toBeCloseTo(expectedAlignedMomentum, 10);
          expect(components.trendPersistenceShadow.shortHorizonMomentumAtr).toBeCloseTo(
            expectedAlignedMomentum,
            10,
          );
        }
      } finally {
        modelSpy.mockRestore();
        governanceSpy.mockRestore();
      }
    },
  );

  it('blocks otherwise admitted PAPER entries when the latest broker close invalidated the current bar', async () => {
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const query = jest.fn().mockImplementation(async (sql: string) =>
      sql.includes('paper_post_loss_state_available')
        ? [
            {
              paper_post_loss_state_available: true,
              trade_id: 'loss-1',
              close_reason: 'STOP_LOSS_HIT',
              closed_at: new Date(Date.now() - 60_000),
              reconfirmed: false,
            },
          ]
        : [],
    );
    const scoutAuthoritySpy = jest
      .spyOn(PaperOpportunityScoutModule, 'evaluatePaperOpportunityScout')
      .mockReturnValue({
        eligible: true,
        reason: 'SHADOW_PULSE_SCOUT',
        lotUpperBound: 0.1,
        sizingTier: 'RESEARCH',
        mode: 'BASE',
        targetWindowMinutes: 30,
        idleMinutes: null,
      });
    const postLossGuardSpy = jest.spyOn(
      PaperPostLossEntryGuardModule,
      'evaluatePaperPostLossEntryGuard',
    );
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const modelSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => ({
        ...actualPlanB(input, positions),
        paperAdmitted: input.instrument === 'EURUSD' && input.direction === 'BUY',
        admitted: input.instrument === 'EURUSD' && input.direction === 'BUY',
        consensusPassed: input.instrument === 'EURUSD' && input.direction === 'BUY' ? 6 : 3,
        consensusRequired: 6,
        expectedR: 0.8,
        strategyRoute: 'TREND_CONTINUATION',
      }));
    const actualGovernance = EnsembleGovernanceModule.evaluateEnsembleGovernance;
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => ({
        ...actualGovernance(input),
        paperExecutionEligible: true,
        paperExecutionBlockers: [],
        netExpectedR: 0.7,
        eventRisk: 'CLEAR',
        driftState: 'NORMAL',
        executionSpreadEvidenceValid: true,
        paperExecutionCostUsable: true,
      }));
    const getOpenPositionsForConnection = jest.fn().mockResolvedValue({ positions: [] });
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'fixture-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection,
      } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );
    try {
      await collector.collectOnce(
        jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => allTrendPayload(),
        }) as unknown as typeof fetch,
      );
      // One read feeds adaptive PAPER risk truth; one independent read feeds
      // the scan-level Plan B portfolio snapshot. The old implementation did
      // another Plan B read for every candidate (13 total in this fixture).
      expect(getOpenPositionsForConnection).toHaveBeenCalledTimes(2);
      expect(getOpenPositionsForConnection).toHaveBeenNthCalledWith(1, 'conn-1', 'user-1');
      expect(getOpenPositionsForConnection).toHaveBeenNthCalledWith(2, 'conn-1', 'user-1');
      expect(scoutAuthoritySpy).toHaveBeenCalled();
      expect(receiveSignal).not.toHaveBeenCalled();
      expect(postLossGuardSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          netExpectedR: 0.7,
          driftState: 'NORMAL',
          consensusPassed: 6,
          consensusRequired: 6,
          eventRisk: 'CLEAR',
          executionCostUsable: true,
        }),
      );
      const insert = query.mock.calls.find(
        ([sql, params]) =>
          String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions') &&
          params[6] === 'EURUSD' &&
          params[7] === 'BUY',
      );
      expect(insert).toBeDefined();
      const components = JSON.parse(String(insert![1][23]));
      expect(components.paperPostLossEntryGuard).toMatchObject({
        eligible: false,
        reason: 'WAITING_FOR_POST_LOSS_BAR',
      });
      expect(components.governance.paperExecutionBlockers).toContain(
        'PAPER_POST_LOSS_WAITING_FOR_POST_LOSS_BAR',
      );
    } finally {
      scoutAuthoritySpy.mockRestore();
      postLossGuardSpy.mockRestore();
      modelSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('evaluates every qualifying pair in the same scan instead of only the top-ranked pair', async () => {
    const live = new LivePaperMarketDataService();
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => allTrendPayload() });

    await collector.collectOnce(fetchMock as unknown as typeof fetch);

    const insertCalls = shadowQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions'),
    );
    expect(insertCalls.length).toBeGreaterThan(1);
    const persistedInstruments = new Set(insertCalls.map(([, params]) => params[6]));
    expect(persistedInstruments.size).toBe(6);
    expect(insertCalls).toHaveLength(12);
    for (const instrument of persistedInstruments) {
      const directions = insertCalls
        .filter(([, params]) => params[6] === instrument)
        .map(([, params]) => params[7]);
      expect(new Set(directions)).toEqual(new Set(['BUY', 'SELL']));
    }
    for (const [, params] of insertCalls) {
      const components = JSON.parse(String(params[23]));
      expect(components.trendPersistenceShadow).toMatchObject({
        artifact: 'trend-persistence-shadow-v1',
        executionAuthority: 'NONE',
        modifiesExecution: false,
      });
    }
    const adaptiveAnnotationCalls = shadowQuery.mock.calls.filter(
      ([sql]) =>
        String(sql).includes('UPDATE trading.ensemble_shadow_decisions') &&
        String(sql).includes("'adaptiveMarketIntelligence'"),
    );
    expect(adaptiveAnnotationCalls).toHaveLength(12);
    for (const [, params] of adaptiveAnnotationCalls) {
      const adaptive = JSON.parse(String(params[3]));
      expect(adaptive).toMatchObject({
        artifact: 'adaptive-market-intelligence-v1',
        executionAuthority: 'PAPER_ONLY',
        productionEligible: false,
      });
      expect(adaptive.marketState.state).not.toBe('UNKNOWN');
      expect(typeof adaptive.opportunity.score).toBe('number');
      expect(adaptive.edge.available).toBe(false);
      expect(adaptive.riskMultiplier.multiplier).toBeLessThanOrEqual(1);
    }
    const scanSummaryCalls = shadowQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("'adaptiveScanSummary'"),
    );
    expect(scanSummaryCalls).toHaveLength(1);
    const noTradeSummary = JSON.parse(String(scanSummaryCalls[0]![1][4]));
    expect(noTradeSummary).toMatchObject({
      artifact: 'adaptive-scan-summary-v1',
      executableWinners: 0,
      reason: 'NO_EXECUTABLE_PAIR_WINNER',
      bestInstrument: expect.any(String),
      bestDirection: expect.stringMatching(/^(BUY|SELL)$/),
      bestAdaptiveScore: expect.any(Number),
      bestNetExpectedR: expect.any(Number),
      bestState: expect.any(String),
      bestBlockers: expect.any(Array),
    });
    expect(noTradeSummary.bestBlockers.length).toBeGreaterThan(0);
  });

  it('persists an idempotent scan summary even when the scan created no decision row', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({}),
      {} as AiSignalService,
      {} as ExecutionService,
      {} as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );
    const scanStartedAt = new Date('2026-10-16T02:10:00.000Z');

    await (collector as any).persistAdaptiveScanSummary({
      userId: '00000000-0000-4000-8000-000000000001',
      connectionId: '11111111-1111-4111-8111-111111111111',
      scanStartedAt,
      evaluatedCandidates: 0,
      executableWinners: 0,
      best: null,
      reason: 'NO_EXECUTABLE_PAIR_WINNER',
    });

    const durableCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO audit.audit_logs'),
    );
    expect(durableCall).toBeDefined();
    expect(String(durableCall![0])).toContain('AI_ADAPTIVE_SCAN_SUMMARY');
    expect(String(durableCall![0])).toContain('$1::uuid');
    expect(String(durableCall![0])).toContain('$2::varchar');
    expect(String(durableCall![0])).toContain('resource_id = $2::varchar');
    expect(durableCall![1][0]).toBe('00000000-0000-4000-8000-000000000001');
    expect(durableCall![1][1]).toBe(
      '11111111-1111-4111-8111-111111111111:2026-10-16T02:10:00.000Z',
    );
    expect(JSON.parse(String(durableCall![1][2]))).toMatchObject({
      artifact: 'adaptive-scan-summary-v1',
      evaluatedCandidates: 0,
      executableWinners: 0,
      reason: 'NO_EXECUTABLE_PAIR_WINNER',
    });
  });

  it('keeps adaptive scan diagnostics non-blocking when durable audit persistence fails', async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (String(sql).includes('INSERT INTO audit.audit_logs')) {
        return Promise.reject(new Error('audit unavailable'));
      }
      return Promise.resolve([]);
    });
    const collector = createCollector(
      config({}),
      {} as AiSignalService,
      {} as ExecutionService,
      {} as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await expect(
      (collector as any).persistAdaptiveScanSummary({
        userId: '00000000-0000-4000-8000-000000000001',
        connectionId: '11111111-1111-4111-8111-111111111111',
        scanStartedAt: new Date('2026-10-16T02:15:00.000Z'),
        evaluatedCandidates: 0,
        executableWinners: 0,
        best: null,
        reason: 'NO_EXECUTABLE_PAIR_WINNER',
      }),
    ).resolves.toBeUndefined();

    expect(query.mock.calls.some(([sql]) => String(sql).includes("'adaptiveScanSummary'"))).toBe(
      true,
    );
  });

  describe('adaptive PAPER provider-position truth', () => {
    function portfolioCollector(
      brokerPositions: Array<{
        externalOrderId: string;
        instrument: string;
        direction: 'BUY' | 'SELL';
        lotSize: string;
      }>,
      rows: Array<Record<string, unknown>>,
    ) {
      const query = jest.fn().mockResolvedValue(rows);
      const getOpenPositionsForConnection = jest.fn().mockResolvedValue({
        positions: brokerPositions,
      });
      const collector = createCollector(
        config({}),
        {} as AiSignalService,
        {} as ExecutionService,
        { getOpenPositionsForConnection } as unknown as BrokerService,
        new LivePaperMarketDataService(),
        aiEngineClientMock(),
        { query } as any,
      );
      return { collector, query, getOpenPositionsForConnection };
    }

    it('does not carry ghost adaptive exposure after the PAPER provider has already closed the position', async () => {
      const { collector, query, getOpenPositionsForConnection } = portfolioCollector(
        [],
        [
          {
            external_order_id: 'paper-order-000041',
            external_position_id: null,
            instrument: 'AUDUSD',
            direction: 'SELL',
            risk_at_stop: '15',
          },
        ],
      );

      await expect(
        (collector as any).loadAdaptiveOpenRiskPositions('user-1', 'conn-1'),
      ).resolves.toEqual({ available: true, positions: [] });
      expect(getOpenPositionsForConnection).toHaveBeenCalledWith('conn-1', 'user-1');
      expect(query).not.toHaveBeenCalled();
    });

    it('maps provider-open PAPER positions to durable risk-at-stop by exact provider position id', async () => {
      const { collector, query } = portfolioCollector(
        [
          {
            externalOrderId: 'paper-order-000042',
            instrument: 'AUDUSD',
            direction: 'SELL',
            lotSize: '0.29',
          },
        ],
        [
          {
            external_order_id: 'paper-order-000042',
            external_position_id: null,
            instrument: 'AUDUSD',
            direction: 'SELL',
            risk_at_stop: '15',
          },
        ],
      );

      await expect(
        (collector as any).loadAdaptiveOpenRiskPositions('user-1', 'conn-1'),
      ).resolves.toEqual({
        available: true,
        positions: [{ instrument: 'AUDUSD', direction: 'SELL', riskAtStop: 15 }],
      });
      expect(String(query.mock.calls[0]?.[0] ?? '')).toContain('external_order_id');
    });

    it('fails closed on risk evidence when a provider-open PAPER position cannot be mapped durably', async () => {
      const { collector } = portfolioCollector(
        [
          {
            externalOrderId: 'paper-order-unmapped',
            instrument: 'GBPUSD',
            direction: 'BUY',
            lotSize: '0.20',
          },
        ],
        [],
      );

      await expect(
        (collector as any).loadAdaptiveOpenRiskPositions('user-1', 'conn-1'),
      ).resolves.toEqual({
        available: true,
        positions: [{ instrument: 'GBPUSD', direction: 'BUY', riskAtStop: null }],
      });
    });
  });

  it('ranks pair winners across the scan and rechecks shared-currency risk before later dispatches', async () => {
    const live = new LivePaperMarketDataService();
    installAlignedFastMarkMirror(live);
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target =
          input.direction === 'BUY' &&
          (input.instrument === 'EURUSD' || input.instrument === 'GBPUSD');
        const expectedR = input.instrument === 'EURUSD' ? 0.35 : 0.3;
        return {
          ...base,
          regime: target ? 'REVERSAL_CONFIRMED' : 'TREND_WEAK',
          strategyRoute: target ? 'CONFIRMED_REVERSAL' : 'TREND_CONTINUATION',
          portfolioQuality: 1,
          paperAdmitted: target,
          admitted: target,
          consensusPassed: target ? 6 : 2,
          consensusRequired: 6,
          directionQuality: target ? 0.82 : 0.2,
          tradeQuality: target ? 0.8 : 0.2,
          exitQuality: target ? 0.78 : 0.2,
          metaProbability: target ? 0.7 : 0.3,
          expectedR: target ? expectedR : -0.2,
          ensembleScore: target ? 0.82 : 0.3,
          reasons: target ? ['ADAPTIVE_TEST_ELIGIBLE'] : ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target =
          input.direction === 'BUY' &&
          (input.instrument === 'EURUSD' || input.instrument === 'GBPUSD');
        const netExpectedR = input.instrument === 'EURUSD' ? 0.3 : 0.28;
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: target ? netExpectedR + 0.04 : -0.2,
          estimatedExecutionCostR: 0.04,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          paperExecutionCostUsable: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: target ? netExpectedR : -0.24,
          paperNetExpectedRPassed: target,
          netExpectedRPassed: target,
          driftState: target ? 'NORMAL' : 'OUT_OF_DISTRIBUTION',
          driftQuality: target ? 1 : 0.2,
          driftDiagnostics: target ? [] : ['confidence:HARD_LOW'],
          paperDriftPassed: target,
          driftPassed: target,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: target,
          paperExecutionBlockers: target ? [] : ['PAPER_NET_EXPECTED_R'],
          paperPromotionEligible: false,
          blockers: target ? ['SLEEVE_COLLECTING'] : ['ENSEMBLE_NOT_ADMITTED'],
        } as any;
      });
    const scoutSpy = jest.spyOn(PaperOpportunityScoutModule, 'evaluatePaperOpportunityScout');
    const reversalSpy = jest
      .spyOn(PairedDirectionReversalModule, 'evaluatePairedDirectionReversal')
      .mockReturnValue({
        buyDirectionalProbability: 0.5,
        sellDirectionalProbability: 0.5,
        preferredDirection: null,
        preferredAbsoluteProbability: 0,
        directionalEdge: 0,
        alignedMomentumAtr: 0,
        researchNetExpectedR: Number.NEGATIVE_INFINITY,
        reversalCandidate: false,
        reason: 'DIRECTION_EDGE_TOO_SMALL',
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockImplementation(async (instrument: string) => ({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument,
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        })),
      } as any,
    );
    jest.spyOn(collector as any, 'loadAdaptiveAllocationCapital').mockResolvedValue('1000');
    jest.spyOn(collector as any, 'loadPaperIdleState').mockResolvedValue({
      available: true,
      lastOpenedAt: new Date(Date.now() - 65 * 60_000),
      idleMinutes: 65,
    });
    const championDirectionPrior =
      PaperChampionDirectionPriorModule.evaluatePaperChampionDirectionPrior({
        instrument: 'GBPUSD',
        direction: 'BUY',
        evidence: { trades: 8, grossProfit: 18, grossLoss: 6, netPnl: 12 },
      });
    const championPriorSnapshotSpy = jest
      .spyOn(collector as any, 'loadPaperChampionDirectionPriorSnapshot')
      .mockResolvedValue([championDirectionPrior]);
    const pairSideReliabilitySpy = jest
      .spyOn(collector as any, 'loadPaperTrendPairSideReliabilityEvidence')
      .mockResolvedValue(null);
    const reversalRouteReliabilitySpy = jest
      .spyOn(collector as any, 'loadPaperReversalRouteReliabilityEvidence')
      .mockResolvedValue({
        closedTrades: 8,
        profitFactor: 1.4,
        sharpe: 1.1,
        maxDrawdown: 0.04,
        positiveWindowFraction: 0.75,
      });
    const riskSnapshotSpy = jest
      .spyOn(collector as any, 'loadAdaptiveOpenRiskPositions')
      .mockResolvedValueOnce({ available: true, positions: [] })
      .mockResolvedValueOnce({ available: true, positions: [] })
      .mockResolvedValue({
        available: true,
        positions: [{ instrument: 'GBPUSD', direction: 'BUY', riskAtStop: 40 }],
      });
    jest.spyOn(collector as any, 'evaluateAdaptiveCore').mockImplementation(async (input: any) => {
      const isGbp = input.candidate.instrument === 'GBPUSD' && input.candidate.direction === 'BUY';
      const isEur = input.candidate.instrument === 'EURUSD' && input.candidate.direction === 'BUY';
      const concentratedEur = isEur && input.portfolio.positions.length > 0;
      const target = isGbp || isEur;
      const score = isGbp ? 0.9 : isEur ? 0.75 : 0.1;
      const blockers = concentratedEur
        ? ['ADAPTIVE_CURRENCY_CONCENTRATION_BLOCKED']
        : target && input.executionRoute === 'NORMAL_PAPER'
          ? []
          : ['LEGACY_ROUTE_NOT_EXECUTABLE'];
      return {
        marketState: {
          artifact: 'adaptive-market-state-v1',
          state: target ? 'REVERSAL' : 'TREND_WEAK',
          stateConfidence: 0.9,
          tradingConfidence: input.candidate.confidence,
          trendStrength: 0.7,
          transitionScore: 0.1,
          reversalScore: 0.8,
          volatilityState: 'NORMAL',
          higherTimeframeAgreement: 0.8,
          session: 'ASIA',
          reasons: ['TEST_STATE'],
          dataFreshness: 'FRESH',
          canUpsize: target,
        },
        edge: {
          artifact: 'adaptive-edge-matrix-v1',
          available: true,
          cellKey: `${input.candidate.instrument}|BUY`,
          evidenceClass: 'QUALIFICATION',
          maturity: 'MATURE',
          recentStatus: 'STABLE',
          closedTrades: 24,
          exactClosedTrades: 24,
          broaderClosedTrades: 0,
          prospectiveSamples: 24,
          priorSamples: 24,
          wins: 18,
          losses: 6,
          smoothedWinRate: 0.72,
          averageRealizedR: 0.4,
          smoothedExpectedR: 0.32,
          profitFactor: 1.8,
          sharpe: 1.3,
          maxDrawdown: 0.05,
          positiveWindowFraction: 0.7,
          averageExecutionCostR: 0.04,
          averageMfeR: 0.7,
          averageMaeR: 0.2,
          averageProfitGivebackR: 0.1,
          calibrationGap: 0.02,
          recentDegradation: false,
          latestResolvedAt: new Date(Date.now() - 60_000).toISOString(),
          sourceLevel: 'EXACT',
          canUpsize: true,
          reason: 'EVIDENCE_AVAILABLE',
          reasons: ['EVIDENCE_AVAILABLE'],
        },
        shadowDirectionalPulse: {
          artifact: 'adaptive-shadow-directional-pulse-v1',
          available: true,
          direction: input.candidate.direction,
          status: 'SUPPORTED',
          candidateSamples: 8,
          oppositeSamples: 8,
          candidateWeightedR: 0.62,
          oppositeWeightedR: -0.28,
          advantageR: 0.9,
          quality: 0.725,
        },
        exposure: {
          artifact: 'adaptive-currency-exposure-v1',
          currencyRiskMap: {},
          candidateCurrencyRisk: {},
          projectedCurrencyRiskMap: {},
          correlatedExposureScore: concentratedEur ? 1 : 0,
          diversificationQuality: concentratedEur ? 0 : 1,
          largestAlignedCurrencyConcentration: concentratedEur ? 2 : 0,
          sameInstrumentDirectionalRisk: 0,
          riskEvidenceComplete: true,
          capacity: concentratedEur ? 'BLOCKED' : 'CLEAR',
          canUpsize: !concentratedEur,
          reasons: concentratedEur
            ? ['SHARED_CURRENCY_CONCENTRATION_BLOCKED']
            : ['PORTFOLIO_CAPACITY_CLEAR'],
        },
        opportunity: {
          artifact: 'adaptive-opportunity-score-v1',
          score: concentratedEur ? 0.2 : score,
          executionEligible: blockers.length === 0,
          hardBlockers: blockers,
          components: {},
          reasons: blockers.length ? ['HARD_GOVERNANCE_BLOCKED'] : ['ADAPTIVE_OPPORTUNITY_HEALTHY'],
        },
        riskMultiplier: {
          artifact: 'adaptive-risk-multiplier-v1',
          multiplier: concentratedEur ? 0.5 : 1,
          canUpsize: false,
          executionEligible: blockers.length === 0,
          hardBlockers: blockers,
          reasons: blockers.length ? ['HARD_GOVERNANCE_BLOCKED'] : ['STANDARD_RISK'],
        },
        candidateRiskAtStop: 20,
        requestedRiskPercent: 2,
        predictionCalibration: {
          authoritative: true,
          sourceLevel: 'EXACT',
          maturity: 'MATURE',
          samples: 12,
          calibratedWinProbability: 0.68,
          profitFactor: 1.8,
          calibratedNetExpectedR: target ? 0.42 : input.governance.netExpectedR,
          recentDegradation: false,
          blockRecommended: false,
          reason: 'CALIBRATION_APPLIED',
        },
        rawNetExpectedR: input.governance.netExpectedR,
        sizingTier: 'BASE',
        sizingUpperBound: 0.1,
        netExpectedR: target ? 0.42 : input.governance.netExpectedR,
        executionCostR: input.governance.estimatedExecutionCostR,
      };
    });

    try {
      await collector.collectOnce(
        jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => allTrendPayload(),
        }) as unknown as typeof fetch,
      );

      expect(championPriorSnapshotSpy).toHaveBeenCalledWith('user-1', 'conn-1');
      expect(scoutSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          idleMinutes: 65,
          netExpectedR: 0.42,
          championDirectionPrior: expect.objectContaining({
            instrument: 'GBPUSD',
            direction: 'BUY',
            supported: true,
            reason: 'CHAMPION_DIRECTION_SUPPORTED',
          }),
          shadowDirectionalPulse: expect.objectContaining({
            status: 'SUPPORTED',
            candidateSamples: 8,
            oppositeSamples: 8,
            advantageR: 0.9,
            quality: 0.725,
          }),
          calibration: expect.objectContaining({
            authoritative: true,
            sourceLevel: 'EXACT',
            samples: 12,
            calibratedNetExpectedR: 0.42,
          }),
        }),
      );
      expect(riskSnapshotSpy).toHaveBeenCalledTimes(3);
      expect(receiveSignal).toHaveBeenCalledTimes(1);
      expect(receiveSignal.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          instrument: 'GBPUSD',
          direction: 'BUY',
          metadata: expect.objectContaining({
            adaptive_scan_rank: 1,
            adaptive_opportunity_score: 0.9,
            adaptive_risk_multiplier: 1,
            adaptive_risk_multiplier_raw: 1,
            paper_champion_direction_risk_cap_active: false,
            paper_champion_direction_risk_cap_reason: 'CHAMPION_DIRECTION_SUPPORTED',
            paper_champion_direction_risk_cap_multiplier: null,
            paper_champion_direction_risk_cap_trades: 8,
            paper_entry_market_alignment_artifact: 'paper-entry-market-alignment-v1',
            paper_entry_market_alignment_reason: 'ALIGNED',
            paper_entry_market_alignment_fast_mark_source: 'STREAM',
            paper_entry_market_alignment_fast_mark_provider: 'DERIV',
            paper_opportunity_scout_mode: 'RECOVERY',
            paper_opportunity_scout_idle_minutes: 65,
            paper_opportunity_scout_target_window_minutes: 30,
            paper_opportunity_scout_shadow_pulse_status: 'SUPPORTED',
            paper_opportunity_scout_shadow_pulse_candidate_samples: 8,
            paper_opportunity_scout_shadow_pulse_opposite_samples: 8,
            paper_opportunity_scout_shadow_pulse_advantage_r: 0.9,
            paper_opportunity_scout_shadow_pulse_quality: 0.725,
          }),
        }),
      );
      expect(
        receiveSignal.mock.calls.some(([signal]) => (signal as any).instrument === 'EURUSD'),
      ).toBe(false);
      expect(pairSideReliabilitySpy).toHaveBeenCalledWith(
        'user-1',
        'conn-1',
        'GBPUSD',
        'BUY',
        'CONFIRMED_REVERSAL',
      );
      expect(reversalRouteReliabilitySpy).toHaveBeenCalledWith('user-1', 'conn-1');
    } finally {
      scoutSpy.mockRestore();
      reversalSpy.mockRestore();
      governanceSpy.mockRestore();
      planBSpy.mockRestore();
    }
  });

  it('keeps collecting calibration diagnostic for extension-exhaustion PAPER research', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    (collector as any).adaptivePredictionCalibration = {
      getCalibration: jest.fn().mockResolvedValue({
        artifact: 'adaptive-prediction-calibration-v1',
        available: true,
        authoritative: true,
        sourceLevel: 'PAIR_DIRECTION_ROUTE',
        maturity: 'COLLECTING',
        samples: 13,
        wins: 4,
        losses: 9,
        empiricalWinRate: 4 / 13,
        rawConfidence: 0.66,
        calibratedWinProbability: 0.44,
        confidenceCorrection: -0.22,
        rawNetExpectedR: 0.14,
        calibratedNetExpectedR: -0.15,
        profitFactor: 0.58,
        recentDegradation: false,
        blockRecommended: false,
        rescueEligible: false,
        reason: 'CALIBRATION_APPLIED',
      }),
    };
    const candidate = buildCandidate('EURUSD', trendCandles())!;
    const result = await (collector as any).evaluateAdaptiveCore({
      userId: 'user-1',
      connectionId: 'conn-1',
      candidate,
      ensemble: {
        regime: 'TREND_EXTENDED',
        strategyRoute: 'TREND_CONTINUATION',
        metaProbability: 0.58,
        directionQuality: 0.42,
        tradeQuality: 0.22,
        exitQuality: 0.23,
        consensusPassed: 4,
        consensusRequired: 6,
      },
      governance: {
        paperExecutionCostUsable: true,
        executionSpreadEvidenceValid: false,
        driftState: 'NORMAL',
        driftQuality: 1,
        netExpectedR: 0.14,
        estimatedExecutionCostR: 0.05,
        paperExecutionBlockers: ['ENSEMBLE_NOT_PAPER_ADMITTED'],
      },
      executionRoute: 'PAPER_EXTENSION_EXHAUSTION_RESEARCH',
      evaluatedAt: new Date('2026-10-16T03:00:00.000Z'),
      allocationCapital: '1000',
      portfolio: { available: true, positions: [] },
      paperResearchPairSideReliability: {
        eligible: true,
        reason: 'POSITIVE_PAIR_SIDE_EXPECTANCY',
        samples: 4,
        wins: 3,
        losses: 1,
        smoothedWinRate: 2 / 3,
        smoothedExpectedR: 0.4,
        realisedRSamples: 4,
        realisedAverageR: 0.45,
      },
    });

    expect(result.predictionCalibration.maturity).toBe('COLLECTING');
    expect(result.predictionCalibration.calibratedNetExpectedR).toBe(-0.15);
    expect(result.rawNetExpectedR).toBe(0.14);
    expect(result.netExpectedR).toBe(0.14);
    expect(result.opportunity.hardBlockers).not.toContain('ADAPTIVE_CALIBRATION_NEGATIVE_EDGE');
  });

  it('uses mature prediction calibration as active PAPER authority inside adaptive scoring', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    (collector as any).adaptivePredictionCalibration = {
      getCalibration: jest.fn().mockResolvedValue({
        artifact: 'adaptive-prediction-calibration-v1',
        available: true,
        authoritative: true,
        sourceLevel: 'PAIR_DIRECTION_ROUTE',
        maturity: 'MATURE',
        samples: 24,
        wins: 6,
        losses: 18,
        empiricalWinRate: 6 / 24,
        rawConfidence: 0.67,
        calibratedWinProbability: 0.41,
        confidenceCorrection: -0.26,
        rawNetExpectedR: 0.12,
        calibratedNetExpectedR: -0.18,
        profitFactor: 0.5,
        recentDegradation: false,
        blockRecommended: true,
        rescueEligible: false,
        reason: 'CALIBRATED_EDGE_UNFAVOURABLE',
      }),
    };
    const candidate = buildCandidate('EURUSD', trendCandles())!;
    const result = await (collector as any).evaluateAdaptiveCore({
      userId: 'user-1',
      connectionId: 'conn-1',
      candidate,
      ensemble: {
        regime: 'TREND_HEALTHY',
        strategyRoute: 'TREND_CONTINUATION',
        metaProbability: 0.7,
        directionQuality: 0.72,
        tradeQuality: 0.74,
        exitQuality: 0.7,
        consensusPassed: 6,
        consensusRequired: 6,
      },
      governance: {
        paperExecutionCostUsable: true,
        executionSpreadEvidenceValid: true,
        driftState: 'NORMAL',
        driftQuality: 0.9,
        netExpectedR: 0.12,
        estimatedExecutionCostR: 0.04,
        paperExecutionBlockers: [],
      },
      executionRoute: 'NORMAL_PAPER',
      evaluatedAt: new Date('2026-10-16T03:00:00.000Z'),
      allocationCapital: '1000',
      portfolio: { available: true, positions: [] },
    });

    expect(result.predictionCalibration.blockRecommended).toBe(true);
    expect(result.rawNetExpectedR).toBe(0.12);
    expect(result.netExpectedR).toBe(-0.18);
    expect(result.opportunity.executionEligible).toBe(false);
    expect(result.opportunity.hardBlockers).toContain('ADAPTIVE_CALIBRATION_NEGATIVE_EDGE');
  });

  it('keeps canary and v11 controlled research shadow-only while preserving evidence', async () => {
    const live = new LivePaperMarketDataService();
    installAlignedFastMarkMirror(live);
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const evidence = {
      global30m: { samples: 15, positive: 12, avgR: 1.088, minR: -0.381, maxR: 5.786 },
      pairSide30m: { samples: 2, positive: 1, avgR: 0.254, minR: -0.381, maxR: 0.888 },
    };
    const getRejectedEdgeCanaryEvidence = jest.fn().mockResolvedValue(evidence);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const canaryTarget = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          ...base,
          strategyRoute: 'TREND_CONTINUATION',
          portfolioQuality: 1,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: canaryTarget ? 5 : 3,
          consensusRequired: 6,
          metaProbability: canaryTarget ? 0.5 : 0.35,
          expectedR: canaryTarget ? 0.25 : -0.2,
          ensembleScore: canaryTarget ? 0.62 : 0.3,
          reasons: canaryTarget ? ['ENSEMBLE_CONSENSUS'] : ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const canaryTarget = input.instrument === 'EURUSD' && input.ensemble.expectedR > 0;
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: canaryTarget ? 0.25 : -0.2,
          estimatedExecutionCostR: 0.03,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: canaryTarget ? 0.22 : -0.23,
          paperNetExpectedRPassed: canaryTarget,
          netExpectedRPassed: canaryTarget,
          driftState: 'OUT_OF_DISTRIBUTION',
          driftQuality: 0.2,
          paperDriftPassed: false,
          driftPassed: false,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: canaryTarget
            ? [
                'ENSEMBLE_NOT_PAPER_ADMITTED',
                'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
                'DRIFT_OUT_OF_DISTRIBUTION',
              ]
            : ['PAPER_NET_EXPECTED_R'],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'DRIFT_OUT_OF_DISTRIBUTION', 'SLEEVE_COLLECTING'],
        };
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
      { getRejectedEdgeCanaryEvidence } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 30,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date().toISOString(),
    });

    try {
      const canaryPayload = allTrendPayload();
      const eurUsdValues = canaryPayload['EUR/USD'].values;
      const previousClose = Number(eurUsdValues.at(-2)!.close);
      const confirmedClose = previousClose + 0.00008;
      eurUsdValues[eurUsdValues.length - 1] = {
        ...eurUsdValues.at(-1)!,
        open: previousClose.toFixed(5),
        high: (confirmedClose + 0.00008).toFixed(5),
        low: (previousClose - 0.00008).toFixed(5),
        close: confirmedClose.toFixed(5),
      };
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => canaryPayload });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);

      expect(getRejectedEdgeCanaryEvidence).toHaveBeenCalledWith('user-1', 'EURUSD', 'BUY');
      // Canary and v11 research scoring/evidence remain active, but neither
      // route may dispatch a PAPER order under the current control.
      expect(receiveSignal).not.toHaveBeenCalled();

      const insertCalls = shadowQuery.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions'),
      );
      expect(insertCalls.length).toBeGreaterThan(0);
      expect(insertCalls.some(([, params]) => params[6] === 'EURUSD' && params[7] === 'BUY')).toBe(
        true,
      );
    } finally {
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('keeps bounded single-MTF-drift v11 research shadow-only while preserving eligibility evidence', async () => {
    const live = new LivePaperMarketDataService();
    installAlignedFastMarkMirror(live);
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          ...base,
          strategyRoute: 'TREND_CONTINUATION',
          portfolioQuality: 1,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: target ? 5 : 3,
          consensusRequired: 6,
          directionQuality: target ? 0.197 : 0.2,
          tradeQuality: target ? 0.218 : 0.2,
          exitQuality: target ? 0.202 : 0.2,
          metaProbability: target ? 0.5 : 0.35,
          expectedR: target ? 0.25 : -0.2,
          ensembleScore: target ? 0.62 : 0.3,
          reasons: target ? ['ENSEMBLE_CONSENSUS'] : ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target = input.instrument === 'EURUSD' && input.ensemble.expectedR > 0;
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: target ? 0.25 : -0.2,
          estimatedExecutionCostR: 0.03,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: target ? 0.084 : -0.23,
          driftDiagnostics: target ? ['mtfStrength:HARD_LOW'] : ['confidence:HARD_LOW'],
          paperNetExpectedRPassed: target,
          netExpectedRPassed: target,
          driftState: 'OUT_OF_DISTRIBUTION',
          driftQuality: 0.2,
          paperDriftPassed: false,
          driftPassed: false,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: target
            ? [
                'ENSEMBLE_NOT_PAPER_ADMITTED',
                'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
                'DRIFT_OUT_OF_DISTRIBUTION',
              ]
            : ['PAPER_NET_EXPECTED_R'],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'SLEEVE_COLLECTING'],
        };
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 30,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date().toISOString(),
    });
    jest.spyOn(collector as any, 'loadPaperResearchEpisodeState').mockResolvedValue({
      previousEpisodeKey: null,
      previousTradeStatus: null,
      previousClosedAt: null,
    });
    jest
      .spyOn(collector as any, 'loadPaperResearchPairSideEvidence')
      .mockResolvedValue({ wins: 1, losses: 2 });
    const logSpy = jest.spyOn((collector as any).logger, 'log');

    try {
      const directionConfirmedPayload = allTrendPayload();
      const eurusdRows = directionConfirmedPayload['EUR/USD'].values;
      const previousClose = Number(eurusdRows[eurusdRows.length - 2]!.close);
      const directionConfirmedClose = previousClose + 0.00008;
      eurusdRows[eurusdRows.length - 1] = {
        ...eurusdRows[eurusdRows.length - 1],
        open: previousClose.toFixed(5),
        high: (directionConfirmedClose + 0.00008).toFixed(5),
        low: (previousClose - 0.00008).toFixed(5),
        close: directionConfirmedClose.toFixed(5),
      };
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => directionConfirmedPayload,
      });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);
      expect(receiveSignal).not.toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'PAPER research-throughput EURUSD BUY execution=ELIGIBLE executionAuthority=PAPER_ONLY_RESEARCH',
          ),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('keeps evidence-backed v11 pair-side acceleration shadow-only while preserving eligibility evidence', async () => {
    const live = new LivePaperMarketDataService();
    installAlignedFastMarkMirror(live);
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          ...base,
          strategyRoute: 'TREND_CONTINUATION',
          portfolioQuality: 1,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: target ? 5 : 3,
          consensusRequired: 6,
          directionQuality: target ? 0.08 : 0.2,
          tradeQuality: target ? 0.28 : 0.2,
          exitQuality: target ? 0.31 : 0.2,
          metaProbability: target ? 0.5 : 0.35,
          expectedR: target ? 0.25 : -0.2,
          ensembleScore: target ? 0.62 : 0.3,
          reasons: target ? ['ENSEMBLE_CONSENSUS'] : ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target = input.instrument === 'EURUSD' && input.ensemble.expectedR > 0;
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: target ? 0.25 : -0.2,
          estimatedExecutionCostR: 0.03,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: target ? 0.14 : -0.23,
          driftDiagnostics: target
            ? ['confidence:HARD_LOW', 'emaSeparation:HARD_LOW', 'mtfStrength:HARD_LOW']
            : ['confidence:HARD_LOW'],
          paperNetExpectedRPassed: target,
          netExpectedRPassed: target,
          driftState: 'OUT_OF_DISTRIBUTION',
          driftQuality: 0.2,
          paperDriftPassed: false,
          driftPassed: false,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: target
            ? [
                'ENSEMBLE_NOT_PAPER_ADMITTED',
                'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
                'DRIFT_OUT_OF_DISTRIBUTION',
              ]
            : ['PAPER_NET_EXPECTED_R'],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'SLEEVE_COLLECTING'],
        };
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 30,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date().toISOString(),
    });
    jest.spyOn(collector as any, 'loadPaperResearchEpisodeState').mockResolvedValue({
      previousEpisodeKey: null,
      previousTradeStatus: null,
      previousClosedAt: null,
    });
    const pairEvidenceSpy = jest
      .spyOn(collector as any, 'loadPaperResearchPairSideEvidence')
      .mockResolvedValue({
        wins: 8,
        losses: 2,
        realisedRSamples: 10,
        realisedRSum: 2.6,
      });
    const portfolioEvidenceSpy = jest
      .spyOn(collector as any, 'loadPaperResearchPortfolioOutcomes')
      .mockResolvedValue(['LOSS', 'LOSS', 'WIN', 'LOSS', 'WIN']);
    const costEvidenceSpy = jest
      .spyOn(collector as any, 'loadPaperCostAwareEntryEvidence')
      .mockResolvedValue({
        grossPositiveSamples: 10,
        costFlippedSamples: 2,
        netPositiveSamples: 8,
      });
    const logSpy = jest.spyOn((collector as any).logger, 'log');

    try {
      const directionConfirmedPayload = allTrendPayload();
      const eurusdRows = directionConfirmedPayload['EUR/USD'].values;
      const previousClose = Number(eurusdRows[eurusdRows.length - 2]!.close);
      const directionConfirmedClose = previousClose + 0.00008;
      eurusdRows[eurusdRows.length - 1] = {
        ...eurusdRows[eurusdRows.length - 1],
        open: previousClose.toFixed(5),
        high: (directionConfirmedClose + 0.00008).toFixed(5),
        low: (previousClose - 0.00008).toFixed(5),
        close: directionConfirmedClose.toFixed(5),
      };
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => directionConfirmedPayload,
      });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);
      expect(pairEvidenceSpy).toHaveBeenCalledWith('user-1', 'conn-1', 'EURUSD', 'BUY');
      expect(portfolioEvidenceSpy).toHaveBeenCalledWith('user-1', 'conn-1');
      expect(costEvidenceSpy).toHaveBeenCalledWith('user-1', 'conn-1', 'EURUSD', 'BUY');
      expect(receiveSignal).not.toHaveBeenCalled();
      const requalificationUpdate = shadowQuery.mock.calls.find(([query]) =>
        String(query).includes("'{paperResearchRequalificationShadow}'"),
      );
      expect(requalificationUpdate).toBeDefined();
      const requalificationPayload = JSON.parse(String(requalificationUpdate?.[1]?.[4]));
      expect(requalificationPayload).toMatchObject({
        artifact: 'paper-research-requalification-shadow-v1',
        candidate: true,
        reason: 'SHADOW_RECOVERY_CANDIDATE',
        executionAuthority: 'NONE',
        modifiesExecution: false,
        qualificationEvidence: false,
        productionEligible: false,
        portfolioBrakeBlocked: true,
        pairSideSamples: 10,
        pairSideRealisedAverageR: 0.26,
        costAwareAction: 'ENTER_NOW',
      });
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'PAPER research requalification EURUSD BUY shadow=CANDIDATE portfolioBrake=RECENT_RESEARCH_LOSS_CLUSTER',
          ),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      planBSpy.mockRestore();
      pairEvidenceSpy.mockRestore();
      portfolioEvidenceSpy.mockRestore();
      costEvidenceSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('keeps calibrated v11 research shadow-only when fixed costs are positive but below the 0.08R floor', async () => {
    const live = new LivePaperMarketDataService();
    installAlignedFastMarkMirror(live);
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          ...base,
          strategyRoute: 'TREND_CONTINUATION',
          portfolioQuality: 1,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: target ? 5 : 3,
          consensusRequired: 6,
          directionQuality: target ? 0.4 : 0.2,
          tradeQuality: target ? 0.55 : 0.2,
          exitQuality: target ? 0.55 : 0.2,
          metaProbability: target ? 0.5 : 0.35,
          expectedR: target ? 0.22 : -0.2,
          ensembleScore: target ? 0.67 : 0.3,
          reasons: target ? ['ENSEMBLE_CONSENSUS'] : ['META_EXPECTED_VALUE'],
        };
      });
    const calibrationSpy = jest
      .spyOn(PaperSpreadCalibrationModule, 'evaluatePaperSpreadCalibrationShadow')
      .mockImplementation((input) => ({
        artifact: 'paper-spread-calibration-shadow-v1',
        instrument: input.instrument,
        session: 'LONDON',
        fixedSpreadPrice: 0.0001,
        calibratedSpreadPrice: 0.00004,
        minimumSpreadFloorPrice: 0.000025,
        sampleCount: 320,
        p95SpreadPrice: 0.00004,
        fixedCostR: 0.18,
        calibratedCostR: 0.13,
        costReductionR: 0.05,
        reason: 'CALIBRATED_P95_WITH_FLOOR',
        executionAuthority: 'NONE',
        modifiesExecution: false,
        qualificationEvidence: false,
      }));
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target = input.instrument === 'EURUSD' && input.direction === 'BUY';
        const calibrated = target && input.paperSimulationSpreadPrice === 0.00004;
        const fixed = target && input.paperSimulationSpreadPrice === 0.0001;
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: target ? 0.22 : -0.2,
          estimatedExecutionCostR: calibrated ? 0.13 : fixed ? 0.18 : 0.03,
          executionCostSource: 'PAPER_SIMULATION_SPREAD',
          executionSpreadEvidenceValid: false,
          executionSpreadEvidence: null,
          paperExecutionCostUsable: true,
          netExpectedR: calibrated ? 0.09 : fixed ? 0.04 : -0.23,
          driftDiagnostics: target ? [] : ['confidence:HARD_LOW'],
          paperNetExpectedRPassed: calibrated,
          netExpectedRPassed: calibrated,
          driftState: target ? 'NORMAL' : 'OUT_OF_DISTRIBUTION',
          driftQuality: target ? 0.9 : 0.2,
          paperDriftPassed: target,
          driftPassed: target,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: target
            ? calibrated
              ? ['ENSEMBLE_NOT_PAPER_ADMITTED', 'ENSEMBLE_NOT_PROMOTABLE_ADMISSION']
              : [
                  'ENSEMBLE_NOT_PAPER_ADMITTED',
                  'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
                  'PAPER_NET_EXPECTED_R',
                ]
            : ['PAPER_NET_EXPECTED_R'],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'SLEEVE_COLLECTING'],
        };
      });
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue(null);
    jest
      .spyOn(collector as any, 'loadPaperSpreadCalibrationHistory')
      .mockResolvedValue({ sampleCount: 320, p95SpreadPrice: 0.00004 });
    jest
      .spyOn(collector as any, 'loadPaperResearchPairSideEvidence')
      .mockResolvedValue({ wins: 0, losses: 0 });
    jest.spyOn(collector as any, 'loadPaperResearchEpisodeState').mockResolvedValue({
      previousEpisodeKey: null,
      previousTradeStatus: null,
      previousClosedAt: null,
    });
    jest.spyOn(collector as any, 'loadPaperCostAwareEntryEvidence').mockResolvedValue({
      grossPositiveSamples: 100,
      costFlippedSamples: 90,
      netPositiveSamples: 10,
    });
    try {
      const directionConfirmedPayload = allTrendPayload();
      const eurusdRows = directionConfirmedPayload['EUR/USD'].values;
      const previousClose = Number(eurusdRows[eurusdRows.length - 2]!.close);
      const directionConfirmedClose = previousClose + 0.00008;
      eurusdRows[eurusdRows.length - 1] = {
        ...eurusdRows[eurusdRows.length - 1],
        open: previousClose.toFixed(5),
        high: (directionConfirmedClose + 0.00008).toFixed(5),
        low: (previousClose - 0.00008).toFixed(5),
        close: directionConfirmedClose.toFixed(5),
      };
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => directionConfirmedPayload });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);

      const targetCalls = governanceSpy.mock.calls
        .map(([input]) => input)
        .filter((input) => input.instrument === 'EURUSD' && input.direction === 'BUY');
      expect(targetCalls.some((input) => input.paperSimulationSpreadPrice === 0.0001)).toBe(true);
      expect(targetCalls.some((input) => input.paperSimulationSpreadPrice === 0.00004)).toBe(true);
      expect(live.getPaperFallbackSpread('EURUSD', 'conn-1')).toBe(0.00004);
      const quote = live.getQuote('EURUSD', 20 * 60_000, 'conn-1');
      expect(Number(quote.ask) - Number(quote.bid)).toBeCloseTo(0.00004, 5);
      const eurusdInsert = shadowQuery.mock.calls.find(
        ([sql, params]) =>
          String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions') &&
          Array.isArray(params) &&
          params[6] === 'EURUSD' &&
          params[7] === 'BUY',
      );
      expect(eurusdInsert).toBeDefined();
      const components = JSON.parse(String(eurusdInsert?.[1]?.[23]));
      expect(components.paperSpreadFallbackAuthority).toMatchObject({
        artifact: 'paper-spread-fallback-authority-v1',
        active: true,
        executionAuthority: 'PAPER_ONLY',
        modifiesExecution: true,
        fallbackSpreadPrice: 0.00004,
        freshProviderOverrides: true,
        qualificationEvidence: false,
      });
      expect(receiveSignal).not.toHaveBeenCalled();
    } finally {
      calibrationSpy.mockRestore();
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('defers an already-eligible PAPER research candidate when pair-side cost drag is high', async () => {
    const live = new LivePaperMarketDataService();
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          ...base,
          strategyRoute: 'TREND_CONTINUATION',
          portfolioQuality: 1,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: target ? 5 : 3,
          consensusRequired: 6,
          directionQuality: target ? 0.08 : 0.2,
          tradeQuality: target ? 0.28 : 0.2,
          exitQuality: target ? 0.31 : 0.2,
          metaProbability: target ? 0.5 : 0.35,
          expectedR: target ? 0.25 : -0.2,
          ensembleScore: target ? 0.62 : 0.3,
          reasons: target ? ['ENSEMBLE_CONSENSUS'] : ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target = input.instrument === 'EURUSD' && input.ensemble.expectedR > 0;
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: target ? 0.25 : -0.2,
          estimatedExecutionCostR: 0.03,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: target ? 0.14 : -0.23,
          driftDiagnostics: target
            ? ['confidence:HARD_LOW', 'emaSeparation:HARD_LOW', 'mtfStrength:HARD_LOW']
            : ['confidence:HARD_LOW'],
          paperNetExpectedRPassed: target,
          netExpectedRPassed: target,
          driftState: 'OUT_OF_DISTRIBUTION',
          driftQuality: 0.2,
          paperDriftPassed: false,
          driftPassed: false,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: target
            ? [
                'ENSEMBLE_NOT_PAPER_ADMITTED',
                'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
                'DRIFT_OUT_OF_DISTRIBUTION',
              ]
            : ['PAPER_NET_EXPECTED_R'],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'SLEEVE_COLLECTING'],
        };
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 30,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date().toISOString(),
    });
    jest.spyOn(collector as any, 'loadPaperResearchEpisodeState').mockResolvedValue({
      previousEpisodeKey: null,
      previousTradeStatus: null,
      previousClosedAt: null,
    });
    const pairEvidenceSpy = jest
      .spyOn(collector as any, 'loadPaperResearchPairSideEvidence')
      .mockResolvedValue({ wins: 3, losses: 1 });
    const costEvidenceSpy = jest
      .spyOn(collector as any, 'loadPaperCostAwareEntryEvidence')
      .mockResolvedValue({
        grossPositiveSamples: 20,
        costFlippedSamples: 11,
        netPositiveSamples: 9,
      });
    const logSpy = jest.spyOn((collector as any).logger, 'log');

    try {
      const directionConfirmedPayload = allTrendPayload();
      const eurusdRows = directionConfirmedPayload['EUR/USD'].values;
      const previousClose = Number(eurusdRows[eurusdRows.length - 2]!.close);
      const directionConfirmedClose = previousClose + 0.00008;
      eurusdRows[eurusdRows.length - 1] = {
        ...eurusdRows[eurusdRows.length - 1],
        open: previousClose.toFixed(5),
        high: (directionConfirmedClose + 0.00008).toFixed(5),
        low: (previousClose - 0.00008).toFixed(5),
        close: directionConfirmedClose.toFixed(5),
      };
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => directionConfirmedPayload,
      });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);
      expect(pairEvidenceSpy).toHaveBeenCalledWith('user-1', 'conn-1', 'EURUSD', 'BUY');
      expect(costEvidenceSpy).toHaveBeenCalledWith('user-1', 'conn-1', 'EURUSD', 'BUY');
      expect(receiveSignal).not.toHaveBeenCalled();
      expect(
        shadowQuery.mock.calls.some(([query]) => String(query).includes("'{paperCostAwareEntry}'")),
      ).toBe(true);
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0]).includes(
            'PAPER cost-aware entry EURUSD BUY execution=DEFER reason=PAIR_SIDE_COST_DRAG',
          ),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      planBSpy.mockRestore();
      pairEvidenceSpy.mockRestore();
      costEvidenceSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('keeps extension-exhaustion research shadow-only after fresh route losses', async () => {
    const live = new LivePaperMarketDataService();
    installAlignedFastMarkMirror(live);
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          ...base,
          regime: target ? 'TREND_EXTENDED' : base.regime,
          strategyRoute: 'TREND_CONTINUATION',
          regimeAllowed: false,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: target ? 4 : 2,
          consensusRequired: 6,
          directionQuality: target ? 0.42 : 0.1,
          tradeQuality: target ? 0.22 : 0.15,
          exitQuality: target ? 0.23 : 0.15,
          metaProbability: target ? 0.58 : 0.3,
          expectedR: target ? 0.14 : -0.3,
          ensembleScore: target ? 0.62 : 0.2,
          reasons: ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target = input.instrument === 'EURUSD' && input.direction === 'BUY';
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: target ? 0.19 : -0.1,
          estimatedExecutionCostR: 0.05,
          executionCostSource: 'PAPER_SIMULATION_SPREAD',
          executionSpreadEvidenceValid: false,
          executionSpreadEvidence: null,
          paperExecutionCostUsable: true,
          netExpectedR: target ? 0.14 : -0.15,
          paperNetExpectedRPassed: target,
          netExpectedRPassed: target,
          driftState: target ? 'NORMAL' : 'OUT_OF_DISTRIBUTION',
          driftQuality: target ? 1 : 0.1,
          driftDiagnostics: target ? [] : ['confidence:HARD_LOW'],
          paperDriftPassed: target,
          driftPassed: target,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: target
            ? ['ENSEMBLE_NOT_PAPER_ADMITTED', 'ENSEMBLE_NOT_PROMOTABLE_ADMISSION']
            : ['PAPER_NET_EXPECTED_R', 'DRIFT_OUT_OF_DISTRIBUTION'],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'SLEEVE_COLLECTING'],
        } as any;
      });
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'test-key',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest
      .spyOn(collector as any, 'loadPaperResearchPairSideEvidence')
      .mockResolvedValue({ wins: 3, losses: 1, realisedRSamples: 4, realisedRSum: 1.8 });
    try {
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => allTrendPayload() });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);
      expect(receiveSignal).not.toHaveBeenCalled();
    } finally {
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
    }
  });

  it('keeps paired-reversal research shadow-only outside the proven Oct 19 M5 cohort', async () => {
    const live = new LivePaperMarketDataService();
    installAlignedFastMarkMirror(live);
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const actualPlanB = PlanBEnsembleModule.scorePlanBMultimodelShadow;
    const actualMeta = V8ShadowMetaModule.scorePlanBShadowMeta;
    const actualPaired = PairedDirectionReversalModule.evaluatePairedDirectionReversal;

    const metaSpy = jest
      .spyOn(V8ShadowMetaModule, 'scorePlanBShadowMeta')
      .mockImplementation((input) => {
        const base = actualMeta(input);
        if (input.instrument !== 'EURUSD') return base;
        const probability = input.direction === 'BUY' ? 0.4 : 0.58;
        return {
          ...base,
          probability,
          expectedR: probability * (2.5 / 1.5) - (1 - probability),
          admitted: input.direction === 'SELL',
          reason: input.direction === 'SELL' ? 'ADMIT' : 'REJECT_EXPECTED_VALUE',
        };
      });
    const planBSpy = jest
      .spyOn(PlanBEnsembleModule, 'scorePlanBMultimodelShadow')
      .mockImplementation((input, positions) => {
        const base = actualPlanB(input, positions);
        const target = input.instrument === 'EURUSD';
        return {
          ...base,
          regime: target ? 'TREND_WEAK' : base.regime,
          strategyRoute: 'TREND_CONTINUATION',
          regimeAllowed: false,
          paperAdmitted: false,
          admitted: false,
          consensusPassed: target ? 4 : 2,
          consensusRequired: 6,
          directionQuality: target ? 0.45 : 0.2,
          tradeQuality: target ? 0.5 : 0.2,
          exitQuality: target ? 0.5 : 0.2,
          metaProbability: target ? (input.direction === 'BUY' ? 0.4 : 0.58) : 0.3,
          expectedR: target ? -0.1 : -0.3,
          ensembleScore: target ? 0.48 : 0.25,
          reasons: ['META_EXPECTED_VALUE'],
        };
      });
    const governanceSpy = jest
      .spyOn(EnsembleGovernanceModule, 'evaluateEnsembleGovernance')
      .mockImplementation((input) => {
        const target = input.instrument === 'EURUSD';
        const pairedReversalDrift = input.driftRoute === 'PAIRED_REVERSAL_RESEARCH';
        return {
          version: EnsembleGovernanceModule.ENSEMBLE_GOVERNANCE_VERSION,
          costModelVersion: EnsembleGovernanceModule.ENSEMBLE_COST_MODEL_VERSION,
          driftModelVersion: EnsembleGovernanceModule.ENSEMBLE_DRIFT_MODEL_VERSION,
          grossExpectedR: -0.1,
          estimatedExecutionCostR: 0.03,
          executionCostSource: 'BROKER_OBSERVED_P90',
          executionSpreadEvidenceValid: true,
          executionSpreadEvidence: {
            source: 'BROKER_OBSERVED_P90',
            spreadPrice: 0.00001,
            sampleCount: 30,
            percentile: 0.9,
            windowMinutes: 30,
            latestSampleAt: new Date().toISOString(),
          },
          netExpectedR: -0.13,
          paperNetExpectedRPassed: false,
          netExpectedRPassed: false,
          driftState: target
            ? pairedReversalDrift
              ? 'NORMAL'
              : 'OUT_OF_DISTRIBUTION'
            : 'OUT_OF_DISTRIBUTION',
          driftQuality: target && pairedReversalDrift ? 0.8 : 0.1,
          paperDriftPassed: target && pairedReversalDrift,
          driftPassed: target && pairedReversalDrift,
          sleeveState: 'COLLECTING',
          sleeveEvidence: null,
          eventRisk: 'CLEAR',
          paperExecutionEligible: false,
          paperExecutionBlockers: [
            'ENSEMBLE_NOT_PAPER_ADMITTED',
            'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
            'PAPER_NET_EXPECTED_R',
            'DRIFT_OUT_OF_DISTRIBUTION',
          ],
          paperPromotionEligible: false,
          blockers: ['ENSEMBLE_NOT_ADMITTED', 'NET_EXPECTED_R', 'SLEEVE_COLLECTING'],
        };
      });
    const pairedSpy = jest
      .spyOn(PairedDirectionReversalModule, 'evaluatePairedDirectionReversal')
      .mockImplementation((input) => {
        if (input.buyProbability === 0.4 && input.sellProbability === 0.58) {
          return {
            buyDirectionalProbability: 0.326,
            sellDirectionalProbability: 0.674,
            preferredDirection: 'SELL',
            preferredAbsoluteProbability: 0.58,
            directionalEdge: 0.348,
            alignedMomentumAtr: 0.4,
            researchNetExpectedR: 0.31,
            reversalCandidate: true,
            reason: 'PAIRED_REVERSAL_CANDIDATE',
          };
        }
        return actualPaired(input);
      });

    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      {
        getCurrentPriceForConnection: jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' }),
        getOpenPositionsForConnection: jest.fn().mockResolvedValue({ positions: [] }),
      } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
      {
        assess: jest.fn().mockResolvedValue({
          state: 'CLEAR',
          provider: 'TEST',
          configured: true,
          checkedAt: new Date().toISOString(),
          instrument: 'EURUSD',
          relevantCountries: [],
          blockWindowMinutesBefore: 30,
          blockWindowMinutesAfter: 30,
          blockingEvents: [],
          reason: null,
          attribution: null,
        }),
      } as any,
    );
    jest.spyOn(collector as any, 'loadEnsembleSleeveEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadExecutionSpreadEvidence').mockResolvedValue({
      source: 'BROKER_OBSERVED_P90',
      spreadPrice: 0.00001,
      sampleCount: 30,
      percentile: 0.9,
      windowMinutes: 30,
      latestSampleAt: new Date().toISOString(),
    });

    try {
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => allTrendPayload() });
      await collector.collectOnce(fetchMock as unknown as typeof fetch);

      expect(governanceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          driftRoute: 'PAIRED_REVERSAL_RESEARCH',
          paperSimulationSpreadPrice: 0.0001,
        }),
      );
      expect(receiveSignal).not.toHaveBeenCalled();
    } finally {
      metaSpy.mockRestore();
      planBSpy.mockRestore();
      governanceSpy.mockRestore();
      pairedSpy.mockRestore();
    }
  });

  it('loads trend-route reliability from episode-collapsed predecessor/current policy shadow evidence', async () => {
    const outcome = (status: 'WIN' | 'LOSS', evaluatedAt: string, resolvedAt: string) => ({
      instrument: status === 'WIN' ? 'EURUSD' : 'USDJPY',
      direction: 'BUY',
      evaluated_at: evaluatedAt,
      outcome: {
        version: 'test',
        status,
        resolvedAt,
        barsObserved: 1,
        exitPrice: 1,
        grossR: status === 'WIN' ? 1.5 : -1,
        netR: status === 'WIN' ? 1.45 : -1.05,
        reason: status === 'WIN' ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
        postEntryTelemetry: null,
      },
    });
    const query = jest
      .fn()
      .mockResolvedValue([
        outcome('WIN', '2026-10-09T10:00:00Z', '2026-10-09T10:20:00Z'),
        outcome('WIN', '2026-10-09T10:05:00Z', '2026-10-09T10:25:00Z'),
        outcome('LOSS', '2026-10-09T10:02:00Z', '2026-10-09T10:10:00Z'),
      ]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const result = await (collector as any).loadPaperTrendRouteReliabilityEvidence(
      'user-1',
      'conn-1',
    );
    expect(result.closedTrades).toBe(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("components->>'strategyRoute' = 'TREND_CONTINUATION'");
    expect(sql).toContain('model_version = ANY($4::text[])');
    expect(sql).toContain("components->'outcome'->>'version' = $5");
    expect(params.slice(0, 3)).toEqual(['user-1', 'conn-1', 'irexpro-multimodel-ensemble-v1']);
    expect(params[3]).toEqual([
      ...PlanBEnsembleModule.PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS,
    ]);
    expect(params[4]).toBe(ENSEMBLE_OUTCOME_MODEL_VERSION);
  });
  it('loads realised continuation route reliability from the exact compatible champion PAPER cohort', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        trades: '30',
        gross_profit: '45.20',
        gross_loss: '64.37',
        net_pnl: '-19.17',
      },
    ]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await expect(
      (collector as any).loadPaperRealisedContinuationRouteEvidence('user-1', 'conn-1'),
    ).resolves.toEqual({
      closedTrades: 30,
      grossProfit: 45.2,
      grossLoss: 64.37,
      netPnl: -19.17,
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("bc.broker_id = 'paper-broker'");
    expect(sql).toContain("t.status = 'CLOSED'");
    expect(sql).toContain('t.realised_pnl IS NOT NULL');
    expect(sql).toContain("ti.status = 'EXECUTED'");
    expect(sql).toContain("ti.timeframe = 'M5'");
    expect(sql).toContain('ti.model_version = $3');
    expect(sql).toContain("ti.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'");
    expect(sql).toContain("ti.metadata->>'external_provider_code' = $4");
    expect(sql).toContain("ti.metadata->>'plan_b_ensemble_strategy_route' = 'TREND_CONTINUATION'");
    expect(sql).toContain("ti.metadata->>'decision_policy_version' = ANY($5::text[])");
    expect(params).toEqual([
      'user-1',
      'conn-1',
      'external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1',
      'irexpro-multimodel-ensemble-v1',
      [...PlanBEnsembleModule.PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS],
    ]);
  });

  it('loads realised payoff from the exact scout model generation only', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([
        { trades: '7', gross_profit: '4.79', gross_loss: '9.46', net_pnl: '-4.67' },
      ]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );
    const modelVersion = paperOpportunityScoutModelVersion('irexpro-multimodel-ensemble-v1');

    await expect(
      (collector as any).loadPaperScoutRealisedPayoffEvidence('user-1', 'conn-1', modelVersion),
    ).resolves.toEqual({
      closedTrades: 7,
      grossProfit: 4.79,
      grossLoss: 9.46,
      netPnl: -4.67,
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("bc.broker_id = 'paper-broker'");
    expect(sql).toContain("t.status = 'CLOSED'");
    expect(sql).toContain("ti.status = 'EXECUTED'");
    expect(sql).toContain("ti.timeframe = 'M5'");
    expect(sql).toContain('ti.model_version = $3');
    expect(sql).toContain("ti.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'");
    expect(params).toEqual(['user-1', 'conn-1', modelVersion]);
  });

  it('caches realised continuation route reliability evidence on the existing reliability TTL', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ trades: 21, gross_profit: 9, gross_loss: 10, net_pnl: -1 }]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const first = await (collector as any).loadPaperRealisedContinuationRouteEvidence(
      'user-1',
      'conn-1',
    );
    const second = await (collector as any).loadPaperRealisedContinuationRouteEvidence(
      'user-1',
      'conn-1',
    );

    expect(first).toEqual({ closedTrades: 21, grossProfit: 9, grossLoss: 10, netPnl: -1 });
    expect(second).toEqual(first);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns neutral collecting realised-route evidence when the aggregate query fails', async () => {
    const query = jest.fn().mockRejectedValue(new Error('temporary database read failure'));
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await expect(
      (collector as any).loadPaperRealisedContinuationRouteEvidence('user-1', 'conn-1'),
    ).resolves.toEqual({ closedTrades: 0, grossProfit: 0, grossLoss: 0, netPnl: 0 });
  });

  it('demotes normal PAPER continuation when mature realised route evidence is weak and pair-side is collecting', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    jest.spyOn(collector as any, 'loadPaperTrendRouteReliabilityEvidence').mockResolvedValue(null);
    jest
      .spyOn(collector as any, 'loadPaperTrendPairSideReliabilityEvidence')
      .mockResolvedValue(null);
    jest
      .spyOn(collector as any, 'loadPaperRealisedContinuationRouteEvidence')
      .mockResolvedValue({ closedTrades: 30, grossProfit: 45.2, grossLoss: 64.37, netPnl: -19.17 });

    await expect(
      (collector as any).evaluatePaperNormalRouteReliabilityGate({
        userId: 'user-1',
        connectionId: 'conn-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        strategyRoute: 'TREND_CONTINUATION',
      }),
    ).resolves.toMatchObject({
      fullSizeEligible: false,
      realisedContinuationRoute: {
        state: 'RESEARCH_ONLY',
        fullSizeEligible: false,
        profitFactor: 45.2 / 64.37,
        closedTrades: 30,
      },
      realisedExecutionGate: {
        routeDemoted: true,
        matureHealthyPairSideOverride: false,
      },
      pairSide: { state: 'COLLECTING' },
    });
  });

  it('allows a mature healthy continuation pair-side to override a weak realised route', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    jest.spyOn(collector as any, 'loadPaperTrendRouteReliabilityEvidence').mockResolvedValue(null);
    jest.spyOn(collector as any, 'loadPaperTrendPairSideReliabilityEvidence').mockResolvedValue({
      closedTrades: 8,
      profitFactor: 1.4,
      sharpe: 1.2,
      maxDrawdown: 0.04,
      positiveWindowFraction: 0.75,
    });
    jest
      .spyOn(collector as any, 'loadPaperRealisedContinuationRouteEvidence')
      .mockResolvedValue({ closedTrades: 30, grossProfit: 45.2, grossLoss: 64.37, netPnl: -19.17 });

    await expect(
      (collector as any).evaluatePaperNormalRouteReliabilityGate({
        userId: 'user-1',
        connectionId: 'conn-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        strategyRoute: 'TREND_CONTINUATION',
      }),
    ).resolves.toMatchObject({
      fullSizeEligible: true,
      realisedContinuationRoute: { state: 'RESEARCH_ONLY' },
      realisedExecutionGate: {
        routeDemoted: false,
        matureHealthyPairSideOverride: true,
      },
      pairSide: { state: 'HEALTHY' },
    });
  });

  it('does not apply the realised continuation brake to confirmed reversal', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const realised = jest
      .spyOn(collector as any, 'loadPaperRealisedContinuationRouteEvidence')
      .mockResolvedValue({ closedTrades: 30, grossProfit: 0, grossLoss: 100, netPnl: -100 });
    jest.spyOn(collector as any, 'loadPaperReversalRouteReliabilityEvidence').mockResolvedValue({
      closedTrades: 8,
      profitFactor: 1.4,
      sharpe: 1.2,
      maxDrawdown: 0.04,
      positiveWindowFraction: 0.75,
    });
    jest
      .spyOn(collector as any, 'loadPaperTrendPairSideReliabilityEvidence')
      .mockResolvedValue(null);

    await expect(
      (collector as any).evaluatePaperNormalRouteReliabilityGate({
        userId: 'user-1',
        connectionId: 'conn-1',
        instrument: 'EURUSD',
        direction: 'SELL',
        strategyRoute: 'CONFIRMED_REVERSAL',
      }),
    ).resolves.toMatchObject({
      fullSizeEligible: true,
      realisedContinuationRoute: null,
      realisedExecutionGate: null,
    });
    expect(realised).not.toHaveBeenCalled();
  });

  it('leaves early transition outside continuation/reversal reliability composition', async () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const realised = jest.spyOn(collector as any, 'loadPaperRealisedContinuationRouteEvidence');
    const pairSide = jest.spyOn(collector as any, 'loadPaperTrendPairSideReliabilityEvidence');

    await expect(
      (collector as any).evaluatePaperNormalRouteReliabilityGate({
        userId: 'user-1',
        connectionId: 'conn-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        strategyRoute: 'EARLY_TRANSITION',
      }),
    ).resolves.toEqual({
      fullSizeEligible: true,
      route: null,
      pairSide: null,
      pairSideShadow: null,
      realisedContinuationRoute: null,
      realisedExecutionGate: null,
    });
    expect(realised).not.toHaveBeenCalled();
    expect(pairSide).not.toHaveBeenCalled();
  });

  it('loads pair-side continuation reliability from independent episode-collapsed shadow evidence', async () => {
    const row = (status: 'WIN' | 'LOSS', evaluatedAt: string, resolvedAt: string) => ({
      instrument: 'EURUSD',
      direction: 'SELL',
      evaluated_at: evaluatedAt,
      outcome: {
        version: 'test',
        status,
        resolvedAt,
        barsObserved: 1,
        exitPrice: 1,
        grossR: status === 'WIN' ? 1.5 : -1,
        netR: status === 'WIN' ? 1.45 : -1.05,
        reason: status === 'WIN' ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
        postEntryTelemetry: null,
      },
    });
    const query = jest
      .fn()
      .mockResolvedValue([
        row('WIN', '2026-10-09T10:00:00Z', '2026-10-09T10:20:00Z'),
        row('WIN', '2026-10-09T10:05:00Z', '2026-10-09T10:25:00Z'),
        row('LOSS', '2026-10-09T10:30:00Z', '2026-10-09T10:40:00Z'),
      ]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    const result = await (collector as any).loadPaperTrendPairSideReliabilityEvidence(
      'user-1',
      'conn-1',
      'EURUSD',
      'SELL',
      'CONFIRMED_REVERSAL',
    );
    expect(result.closedTrades).toBe(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('instrument = $5');
    expect(sql).toContain('direction = $6');
    expect(sql).toContain("components->>'strategyRoute' = $7");
    expect(sql).toContain("components->'outcome'->>'version' = $8");
    expect(params.slice(0, 3)).toEqual(['user-1', 'conn-1', 'irexpro-multimodel-ensemble-v1']);
    expect(params[4]).toBe('EURUSD');
    expect(params[5]).toBe('SELL');
    expect(params[6]).toBe('CONFIRMED_REVERSAL');
    expect(params[7]).toBe(ENSEMBLE_OUTCOME_MODEL_VERSION);
  });

  it('loads pair-side research reliability only from the active episode-guarded research artifact', async () => {
    const activePolicy = 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1';
    const query = jest.fn().mockResolvedValue([
      {
        policy_version: activePolicy,
        realised_pnl: 2,
        closed_at: new Date('2026-10-16T10:30:00Z'),
      },
      {
        policy_version: activePolicy,
        realised_pnl: -1,
        closed_at: new Date('2026-10-16T10:25:00Z'),
      },
      {
        policy_version: activePolicy,
        realised_pnl: -1,
        closed_at: new Date('2026-10-16T10:20:00Z'),
      },
      {
        policy_version: activePolicy,
        realised_pnl: -1,
        closed_at: new Date('2026-10-16T10:15:00Z'),
      },
      {
        policy_version: activePolicy,
        realised_pnl: -1,
        closed_at: new Date('2026-10-16T10:10:00Z'),
      },
      {
        policy_version: activePolicy,
        realised_pnl: -1,
        closed_at: new Date('2026-10-16T10:05:00Z'),
      },
    ]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );

    await expect(
      (collector as any).loadPaperResearchPairSideEvidence('user-1', 'conn-1', 'GBPUSD', 'SELL'),
    ).resolves.toEqual({
      wins: 1,
      losses: 5,
      realisedRSamples: 0,
      realisedRSum: 0,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("paper_research_throughput_artifact' = ANY($5::text[])"),
      [
        'user-1',
        'conn-1',
        'GBPUSD',
        'SELL',
        [
          'paper-research-throughput-v2-episode-guarded',
          'paper-research-throughput-v3-episode-guarded',
          'paper-research-throughput-v4-pair-side-reliability',
          'paper-research-throughput-v5-controlled-execution',
          'paper-research-throughput-v6-controlled-exploration',
          'paper-research-throughput-v7-edge-tiered-exploration',
          'paper-research-throughput-v8-momentum-confirmed-exploration',
          'paper-research-throughput-v9-bounded-mtf-exploration',
          'paper-research-throughput-v10-evidence-backed-acceleration',
          'paper-research-throughput-v11-momentum-confirmed-exploration',
        ],
        ['planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1', activePolicy],
        activePolicy,
      ],
    );
  });

  it('persists shadow evidence without an active PAPER session and keeps execution disabled', async () => {
    const live = new LivePaperMarketDataService();
    const receiveSignal = jest.fn();
    const heartbeat = jest.fn();
    const shadowQuery = jest.fn().mockResolvedValue([]);
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      { getCurrentPriceForConnection: heartbeat } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
      { query: shadowQuery } as any,
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() });

    const calibrationHistorySpy = jest
      .spyOn(collector as any, 'loadPaperSpreadCalibrationHistory')
      .mockResolvedValue({ sampleCount: 240, p95SpreadPrice: 0.00002 });

    await collector.collectOnce(fetchMock as unknown as typeof fetch);

    expect(receiveSignal).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(live.getQuote('EURUSD', 20 * 60_000, 'conn-1').bid).toBeTruthy();
    expect(live.isLiveConnection('conn-1')).toBe(false);
    expect(shadowQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO trading.ensemble_shadow_decisions'),
      expect.arrayContaining(['user-1', null, 'conn-1', 'irexpro-multimodel-ensemble-v1']),
    );
    expect(calibrationHistorySpy).toHaveBeenCalled();
    const eurusdInsert = shadowQuery.mock.calls.find(
      ([sql, params]) =>
        String(sql).includes('INSERT INTO trading.ensemble_shadow_decisions') &&
        Array.isArray(params) &&
        params[6] === 'EURUSD',
    );
    expect(eurusdInsert).toBeDefined();
    const eurusdComponents = JSON.parse(String(eurusdInsert?.[1]?.[23]));
    expect(eurusdComponents.paperSpreadCalibrationShadow).toMatchObject({
      artifact: 'paper-spread-calibration-shadow-v1',
      fixedSpreadPrice: 0.0001,
      calibratedSpreadPrice: 0.000025,
      executionAuthority: 'NONE',
      modifiesExecution: false,
      qualificationEvidence: false,
    });
    expect((collector as any).lastEnsembleDecision.evaluatedAt).toBeInstanceOf(Date);
    expect((collector as any).lastEnsembleDecision.instrument).toBe('EURUSD');
  });

  it('does not block API bootstrap while startup market priming is unresolved', async () => {
    const live = new LivePaperMarketDataService();
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      {} as unknown as BrokerService,
      live,
      aiEngineClientMock(),
    );
    jest.spyOn(collector as any, 'marketSchedule').mockReturnValue({
      paused: false,
      reason: null,
      nextEligibleScanAt: '2026-10-12T11:45:00.000Z',
    });
    let releasePrime!: () => void;
    const primeGate = new Promise<void>((resolve) => {
      releasePrime = resolve;
    });
    const primeSpy = jest.spyOn(collector as any, 'primeMarketData').mockReturnValue(primeGate);
    const initPromise = collector.onModuleInit();

    try {
      const state = await Promise.race([
        initPromise.then(() => 'RESOLVED' as const),
        new Promise<'BLOCKED'>((resolve) => setTimeout(() => resolve('BLOCKED'), 75)),
      ]);
      expect(state).toBe('RESOLVED');
      expect(primeSpy).toHaveBeenCalledWith('real-key-123456', 'conn-1');
      expect(live.isLiveConnection('conn-1')).toBe(true);
      expect(() => live.getQuote('EURUSD', 20 * 60_000, 'conn-1')).toThrow();
      const collectSpy = jest.spyOn(collector, 'collectOnce').mockResolvedValue();
      await collector.maybeCollect(new Date('2026-10-12T11:45:00.000Z'));
      expect(collectSpy).not.toHaveBeenCalled();
    } finally {
      releasePrime();
      await initPromise;
      const startupPrime = (collector as any).startupPrimePromise as Promise<void> | null;
      if (startupPrime) await startupPrime;
      collector.onModuleDestroy();
    }
  });

  it('stops a legacy scheduler job for the exact active PAPER session on scanner startup', async () => {
    const live = new LivePaperMarketDataService();
    const aiEngine = aiEngineClientMock();
    const execution = {
      getActiveSession: jest.fn().mockResolvedValue({
        id: 'session-1',
        brokerConnectionId: 'conn-1',
        executionMode: ExecutionMode.PAPER_ONLY,
      }),
    } as unknown as ExecutionService;
    const startupHeartbeat = jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' });
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      execution,
      { getCurrentPriceForConnection: startupHeartbeat } as unknown as BrokerService,
      live,
      aiEngine,
    );

    jest.spyOn(collector as any, 'marketSchedule').mockReturnValue({
      paused: false,
      reason: null,
      nextEligibleScanAt: '2026-10-02T20:30:00.000Z',
    });
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() } as Response);

    await collector.onModuleInit();
    const startupPrime = (collector as any).startupPrimePromise as Promise<void> | null;
    if (startupPrime) await startupPrime;

    expect(aiEngine.notifySessionStopped).toHaveBeenCalledWith({ tradingSessionId: 'session-1' });
    expect(live.isLiveConnection('conn-1')).toBe(true);
    expect(live.status('conn-1').cachedInstrumentCount).toBe(6);
    expect(startupHeartbeat).toHaveBeenCalledTimes(6);

    collector.onModuleDestroy();
    fetchSpy.mockRestore();
    expect(live.isLiveConnection('conn-1')).toBe(false);
  });

  it('reuses a successful six-pair provider batch within the same UTC minute', async () => {
    const live = new LivePaperMarketDataService();
    live.registerLiveConnection('conn-1');
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'EXECUTION_SUCCEEDED' });
    const heartbeat = jest.fn().mockResolvedValue({ bid: '1', ask: '1.1' });
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest.fn().mockResolvedValue({
          id: 'session-1',
          brokerConnectionId: 'conn-1',
          executionMode: ExecutionMode.PAPER_ONLY,
        }),
      } as unknown as ExecutionService,
      { getCurrentPriceForConnection: heartbeat } as unknown as BrokerService,
      live,
      aiEngineClientMock(),
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => payload() });

    await collector.collectOnce(fetchMock as unknown as typeof fetch);
    await collector.collectOnce(fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(12);
  });

  it('primes all six pairs once, then refreshes only two pairs per M5 slot while retaining a coherent six-pair snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00.000Z'));
    try {
      const collector = createCollector(
        config({
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.apiKey': 'real-key-123456',
          'vpsForexScanner.userId': 'user-1',
          'vpsForexScanner.brokerConnectionId': 'conn-1',
        }),
        { receiveSignal: jest.fn() } as unknown as AiSignalService,
        { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
        {} as unknown as BrokerService,
        new LivePaperMarketDataService(),
        aiEngineClientMock(),
      );
      const fullPayload = payload();
      const requestedBatches: string[][] = [];
      const fetchMock = jest.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const requested = (url.searchParams.get('symbol') ?? '').split(',').filter(Boolean);
        requestedBatches.push(requested);
        const body = Object.fromEntries(requested.map((symbol) => [symbol, fullPayload[symbol]]));
        return new Response(JSON.stringify(body), { status: 200 });
      });

      const startup = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );
      expect(startup.size).toBe(6);
      expect(requestedBatches[0]).toEqual(PAIRS.map(([, provider]) => provider));

      jest.setSystemTime(new Date('2026-10-13T00:05:00.000Z'));
      const slotOne = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );
      jest.setSystemTime(new Date('2026-10-13T00:10:00.000Z'));
      const slotTwo = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );
      jest.setSystemTime(new Date('2026-10-13T00:15:00.000Z'));
      const slotThree = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );

      expect(requestedBatches.slice(1)).toEqual([
        ['USD/JPY', 'AUD/USD'],
        ['USD/CAD', 'USD/CHF'],
        ['EUR/USD', 'GBP/USD'],
      ]);
      expect(requestedBatches.slice(1).every((batch) => batch.length === 2)).toBe(true);
      for (const snapshot of [slotOne, slotTwo, slotThree]) {
        expect([...snapshot.keys()].sort()).toEqual(PAIRS.map(([instrument]) => instrument).sort());
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the steady-state Twelve Data budget below the 800-credit Basic daily allowance', () => {
    const fiveMinuteSlotsPerDay = (24 * 60) / 5;
    const steadyStateCredits = fiveMinuteSlotsPerDay * 2;
    const startupPrimeCredits = PAIRS.length;
    expect(steadyStateCredits).toBe(576);
    expect(steadyStateCredits + startupPrimeCredits).toBeLessThan(800);
  });

  it('reports PAPER authority waiting for a PAPER session when observation data is ready', async () => {
    const live = new LivePaperMarketDataService();
    for (const [instrument] of PAIRS) {
      const base =
        instrument === 'USDJPY'
          ? 157
          : instrument === 'GBPUSD'
            ? 1.34
            : instrument === 'USDCAD'
              ? 1.37
              : instrument === 'USDCHF'
                ? 0.8
                : instrument === 'AUDUSD'
                  ? 0.66
                  : 1.1;
      live.updateClosedCandles(
        instrument,
        trendCandles(base, instrument === 'USDJPY' ? 3 : 5),
        'conn-1',
      );
    }
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      {} as unknown as BrokerService,
      live,
      aiEngineClientMock(),
    );
    jest.spyOn(collector as any, 'marketSchedule').mockReturnValue({
      paused: false,
      reason: null,
      nextEligibleScanAt: '2026-10-05T10:10:00.000Z',
    });

    const status = await collector.getStatus('user-1');

    expect(status.activePaperSession).toBe(false);
    expect(status.marketCache.cachedInstrumentCount).toBe(6);
    expect(status.executionAuthority).toBe('PAPER_ONLY');
    expect(status.state).toBe('WAITING_FOR_PAPER_SESSION');
  });

  it('uses the full FX 24x5 session instead of pausing every weekday night', () => {
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );

    const saturday = (collector as any).marketSchedule(new Date('2026-10-03T00:21:00.000Z'));
    expect(saturday).toEqual({
      paused: true,
      reason: 'WEEKEND',
      nextEligibleScanAt: '2026-10-04T21:00:00.000Z',
    });

    expect((collector as any).marketSchedule(new Date('2026-10-04T20:50:00.000Z')).paused).toBe(
      true,
    );
    expect((collector as any).marketSchedule(new Date('2026-10-04T21:00:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-10-05T22:10:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-10-09T20:50:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-10-09T21:00:00.000Z')).paused).toBe(
      true,
    );

    // New York switches back to EST in November. Weekly open/close must
    // continue to follow 17:00 America/New_York instead of a fixed UTC hour.
    expect((collector as any).marketSchedule(new Date('2026-12-06T21:55:00.000Z')).paused).toBe(
      true,
    );
    expect((collector as any).marketSchedule(new Date('2026-12-06T22:00:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-12-11T21:55:00.000Z')).paused).toBe(
      false,
    );
    expect((collector as any).marketSchedule(new Date('2026-12-11T22:00:00.000Z')).paused).toBe(
      true,
    );
  });

  it('refreshes stale cached M5 tails from active PAPER M1 before scoring the six-pair snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T11:00:20.000Z'));
    try {
      const baseFor = (instrument: string) =>
        instrument === 'USDJPY'
          ? 157
          : instrument === 'GBPUSD'
            ? 1.34
            : instrument === 'USDCAD'
              ? 1.37
              : instrument === 'USDCHF'
                ? 0.8
                : instrument === 'AUDUSD'
                  ? 0.66
                  : 1.1;
      const digitsFor = (instrument: string) => (instrument === 'USDJPY' ? 3 : 5);
      const staleSeries = new Map(
        PAIRS.map(([instrument]) => [
          instrument,
          trendCandles(baseFor(instrument), digitsFor(instrument)).map((row) => ({
            ...row,
            timestamp: new Date(row.timestamp.getTime() - 300_000),
          })),
        ]),
      );
      const freshM1 = (instrument: string) => {
        const base = baseFor(instrument);
        const digits = digitsFor(instrument);
        const latestOpen = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
        return Array.from({ length: 30 }, (_, index) => {
          const openTime = latestOpen - (29 - index) * 60_000;
          const close = base + index * (base > 10 ? 0.001 : 0.00001);
          const range = base > 10 ? 0.01 : 0.00008;
          return {
            timestamp: new Date(openTime),
            open: close.toFixed(digits),
            high: (close + range).toFixed(digits),
            low: (close - range).toFixed(digits),
            close: close.toFixed(digits),
            volume: '0',
          };
        });
      };
      const broker = {
        getOhlcvForConnection: jest
          .fn()
          .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) =>
            freshM1(instrument),
          ),
      } as unknown as BrokerService;
      const collector = createCollector(
        config({
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.apiKey': 'real-key-123456',
          'vpsForexScanner.userId': 'user-1',
          'vpsForexScanner.brokerConnectionId': 'conn-1',
          'multimodelBrokerExpert.enabled': true,
          'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
        }),
        { receiveSignal: jest.fn() } as unknown as AiSignalService,
        { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
        broker,
        new LivePaperMarketDataService(),
        aiEngineClientMock(),
      );
      (collector as any).lastProviderSeries = staleSeries;
      (collector as any).lastProviderFetchMinute = '2026-10-26T10:59';
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => allTrendPayload(),
      });

      const series = await (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      );

      const expectedLatestOpen = new Date('2026-10-26T10:55:00.000Z').getTime();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(4);
      for (const call of (broker as any).getOhlcvForConnection.mock.calls) {
        expect(call[0]).toBe('user-1');
        expect(call[1]).toBe('conn-1');
        expect(call[3]).toBe('M1');
        expect(call[4]).toBe(30);
      }
      expect(series.size).toBe(6);
      for (const candles of series.values()) {
        expect(candles.at(-1)?.timestamp.getTime()).toBe(expectedLatestOpen);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads scanner-owned live PAPER M1 directly instead of querying a disconnected execution broker', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T11:00:20.000Z'));
    try {
      const baseFor = (instrument: string) =>
        instrument === 'USDJPY'
          ? 157
          : instrument === 'GBPUSD'
            ? 1.34
            : instrument === 'USDCAD'
              ? 1.37
              : instrument === 'USDCHF'
                ? 0.8
                : instrument === 'AUDUSD'
                  ? 0.66
                  : 1.1;
      const digitsFor = (instrument: string) => (instrument === 'USDJPY' ? 3 : 5);
      const staleSeries = new Map(
        PAIRS.map(([instrument]) => [
          instrument,
          trendCandles(baseFor(instrument), digitsFor(instrument)).map((row) => ({
            ...row,
            timestamp: new Date(row.timestamp.getTime() - 300_000),
          })),
        ]),
      );
      const freshM1 = (instrument: string) => {
        const base = baseFor(instrument);
        const digits = digitsFor(instrument);
        const latestOpen = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
        return Array.from({ length: 30 }, (_, index) => {
          const openTime = latestOpen - (29 - index) * 60_000;
          const close = base + index * (base > 10 ? 0.001 : 0.00001);
          const range = base > 10 ? 0.01 : 0.00008;
          return {
            timestamp: new Date(openTime),
            open: close.toFixed(digits),
            high: (close + range).toFixed(digits),
            low: (close - range).toFixed(digits),
            close: close.toFixed(digits),
          };
        });
      };
      const liveMarket = new LivePaperMarketDataService();
      liveMarket.registerLiveConnection('conn-1');
      for (const [instrument] of PAIRS) {
        liveMarket.updateClosedM1Candles(instrument, freshM1(instrument), 'conn-1');
      }
      const broker = {
        getOhlcvForConnection: jest
          .fn()
          .mockRejectedValue(new Error('disconnected execution broker must not be queried')),
      } as unknown as BrokerService;
      const collector = createCollector(
        config({
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.userId': 'user-1',
          'vpsForexScanner.brokerConnectionId': 'conn-1',
        }),
        { receiveSignal: jest.fn() } as unknown as AiSignalService,
        { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
        broker,
        liveMarket,
        aiEngineClientMock(),
      );

      const refreshed = await (collector as any).refreshStalePaperProviderM5Tails(
        staleSeries,
        Date.now(),
      );

      expect((broker as any).getOhlcvForConnection).not.toHaveBeenCalled();
      const expectedLatestOpen = new Date('2026-10-26T10:55:00.000Z').getTime();
      for (const candles of refreshed.values()) {
        expect(candles.at(-1)?.timestamp.getTime()).toBe(expectedLatestOpen);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds broker-native six-pair history concurrency below the MetaApi per-account limit', async () => {
    let active = 0;
    let peak = 0;
    const broker = {
      findConnectionById: jest
        .fn()
        .mockResolvedValue({ brokerId: 'metatrader5', status: 'CONNECTED' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          const base = instrument === 'USDJPY' ? 157 : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );

    const series = await (collector as any).fetchBrokerNativeFallbackSeries('TEST_RATE_LIMIT');

    expect(series.size).toBe(6);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('paces cTrader six-pair background history below the shared 5-per-second budget', async () => {
    let active = 0;
    let peak = 0;
    const startedAt: number[] = [];
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({ brokerId: 'ctrader', status: 'CONNECTED' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          startedAt.push(Date.now());
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          const base = instrument === 'USDJPY' ? 157 : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'ctrader-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );

    const series = await (collector as any).fetchBrokerNativeFallbackSeries('TEST_CTRADER_PACING');

    expect(series.size).toBe(6);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(6);
    expect(peak).toBe(1);
    expect(startedAt).toHaveLength(6);
    for (let i = 1; i < startedAt.length; i += 1) {
      expect(startedAt[i]! - startedAt[i - 1]!).toBeGreaterThanOrEqual(200);
    }
  });

  it('uses the configured broker-native source for Plan B portfolio truth instead of the PAPER evidence connection', async () => {
    const getOpenPositionsForConnection = jest.fn().mockResolvedValue({
      positions: [{ instrument: 'EURUSD', direction: 'BUY', lotSize: '0.20' }],
    });
    const collector = createCollector(
      config({
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'ctrader-1',
      }),
      {} as AiSignalService,
      {} as ExecutionService,
      { getOpenPositionsForConnection } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );

    const snapshot = await (collector as any).loadPlanBPortfolioSnapshot(
      'user-1',
      'paper-1',
    );

    expect(getOpenPositionsForConnection).toHaveBeenCalledTimes(1);
    expect(getOpenPositionsForConnection).toHaveBeenCalledWith('ctrader-1', 'user-1');
    expect(snapshot).toEqual({
      available: true,
      connectionId: 'ctrader-1',
      positions: [{ instrument: 'EURUSD', direction: 'BUY', lotSize: '0.20' }],
    });
  });

  it('retries a background broker-history read after a bounded RATE_LIMITED refill delay', async () => {
    jest.useFakeTimers();
    try {
      const rows = trendCandles(1.1, 5).map((row) => ({ ...row, volume: '0' }));
      const getOhlcvForConnection = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('local history budget exhausted'), { code: 'RATE_LIMITED' }))
        .mockResolvedValue(rows);
      const collector = createCollector(
        config({}),
        { receiveSignal: jest.fn() } as unknown as AiSignalService,
        { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
        { getOhlcvForConnection } as unknown as BrokerService,
        new LivePaperMarketDataService(),
        aiEngineClientMock(),
      );

      const pending = (collector as any).readBrokerHistoryWithRateLimitRetry(
        'user-1', 'ctrader-1', 'EURUSD', 'M5', 500,
      );
      await Promise.resolve();
      expect(getOhlcvForConnection).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual(rows);
      expect(getOhlcvForConnection).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry a background broker-history read for non-rate-limit failures', async () => {
    const getOhlcvForConnection = jest.fn().mockRejectedValue(new Error('provider candles unavailable'));
    const collector = createCollector(
      config({}),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      { getOhlcvForConnection } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );

    await expect(
      (collector as any).readBrokerHistoryWithRateLimitRetry(
        'user-1', 'ctrader-1', 'EURUSD', 'M5', 500,
      ),
    ).rejects.toThrow('provider candles unavailable');
    expect(getOhlcvForConnection).toHaveBeenCalledTimes(1);
  });

  it('fails over to broker-native MetaTrader candles after Twelve Data exhausts the daily quota', async () => {
    const live = new LivePaperMarketDataService();
    const broker = {
      findConnectionById: jest
        .fn()
        .mockResolvedValue({ brokerId: 'metatrader5', status: 'CONNECTED' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          const base =
            instrument === 'USDJPY'
              ? 157
              : instrument === 'GBPUSD'
                ? 1.34
                : instrument === 'USDCAD'
                  ? 1.37
                  : instrument === 'USDCHF'
                    ? 0.8
                    : instrument === 'AUDUSD'
                      ? 0.66
                      : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      live,
      aiEngineClientMock(),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        status: 'error',
        message:
          'You have run out of API credits for the day. The current limit being 800 API credits per day.',
      }),
    });

    const series = await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      fetchMock as unknown as typeof fetch,
    );
    const status = await collector.getStatus('user-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(series.size).toBe(6);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(6);
    expect(status.providerCooldownReason).toBe('DAILY_CREDIT_LIMIT');
    expect(status.providerCooldownUntil).toBeTruthy();
    expect(status.marketDataAuthority).toBe('METAAPI_BROKER_FALLBACK');
    expect(status.providerFallbackActive).toBe(true);
  });

  it('uses connected cTrader candles as broker-native fallback after Twelve Data exhausts the daily quota', async () => {
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({
        brokerId: 'ctrader',
        status: 'CONNECTED',
      }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          const base = instrument === 'USDJPY' ? 157 : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'ctrader-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        status: 'error',
        message: 'You have run out of API credits for the day.',
      }),
    });

    const series = await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      fetchMock as unknown as typeof fetch,
    );

    expect(series.size).toBe(6);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(6);
  });

  it('uses fresh persisted broker-native M5 cache before spending cTrader historical requests', async () => {
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({
        brokerId: 'ctrader',
        status: 'CONNECTED',
      }),
      getOhlcvForConnection: jest.fn().mockRejectedValue(new Error('provider history should not be called')),
    } as unknown as BrokerService;
    const store = {
      getCandles: jest.fn().mockImplementation(async (_connectionId, instrument) => {
        const base = instrument === 'USDJPY' ? 157 : 1.1;
        const digits = instrument === 'USDJPY' ? 3 : 5;
        return trendCandles(base, digits, undefined, undefined, 60).map((row) => ({
          ...row,
          volume: '0',
        }));
      }),
    };
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'ctrader-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    (collector as any).providerQuoteCandleStore = store;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        status: 'error',
        message: 'You have run out of API credits for the day.',
      }),
    });

    const series = await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      fetchMock as unknown as typeof fetch,
    );

    expect(series.size).toBe(6);
    expect(store.getCandles).toHaveBeenCalledTimes(6);
    expect((broker as any).getOhlcvForConnection).not.toHaveBeenCalled();
  });

  it('lets the legacy high-conviction overlay score a connected cTrader source', async () => {
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({
        brokerId: 'ctrader',
        status: 'CONNECTED',
      }),
    } as unknown as BrokerService;
    const aiEngine = {
      ...aiEngineClientMock(),
      scorePlanBV4ChallengerBroker: jest.fn().mockResolvedValue({
        state: 'UNAVAILABLE',
        reason: 'SCORER_PROBE_UNAVAILABLE',
        decision_time: null,
        market_data_sources: {},
        score: null,
      }),
    } as any;
    const collector = createCollector(
      config({
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'ctrader-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngine,
    );

    const result = await (collector as any).evaluateHighConvictionOverlay('user-1', {
      instrument: 'EURUSD',
      direction: 'BUY',
      barTime: new Date('2026-10-28T19:40:00.000Z'),
    });

    expect(result.reason).toBe('SCORER_PROBE_UNAVAILABLE');
  });

  it('reuses broker-native fallback within the minute while daily cooldown is active', async () => {
    const broker = {
      findConnectionById: jest
        .fn()
        .mockResolvedValue({ brokerId: 'metatrader5', status: 'CONNECTED' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_userId: string, _connectionId: string, instrument: string) => {
          const base = instrument === 'USDJPY' ? 157 : 1.1;
          const digits = instrument === 'USDJPY' ? 3 : 5;
          return trendCandles(base, digits).map((row) => ({ ...row, volume: '0' }));
        }),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        status: 'error',
        message: 'You have run out of API credits for the day.',
      }),
    });

    await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      fetchMock as unknown as typeof fetch,
    );
    await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((broker as any).getOhlcvForConnection).toHaveBeenCalledTimes(6);
  });

  it('rejects a non-connected MetaTrader fallback source before any history request', async () => {
    const getOhlcvForConnection = jest.fn().mockRejectedValue(new Error('must not be called'));
    const broker = {
      findConnectionById: jest.fn().mockResolvedValue({
        brokerId: 'metatrader5',
        status: 'SUSPENDED',
      }),
      getOhlcvForConnection,
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );

    await expect(
      (collector as any).fetchBrokerNativeFallbackSeries('TWELVE_DATA_DAILY_CREDIT_LIMIT'),
    ).rejects.toMatchObject({
      code: 'BROKER_FALLBACK_SOURCE_UNAVAILABLE',
    });
    expect(getOhlcvForConnection).not.toHaveBeenCalled();
  });

  it('fails closed when both Twelve Data quota and broker-native fallback are unavailable', async () => {
    const broker = {
      findConnectionById: jest
        .fn()
        .mockResolvedValue({ brokerId: 'metatrader5', status: 'CONNECTED' }),
      getOhlcvForConnection: jest.fn().mockRejectedValue(new Error('broker candles unavailable')),
    } as unknown as BrokerService;
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        status: 'error',
        message: 'You have run out of API credits for the day.',
      }),
    });

    await expect(
      (collector as any).fetchSixPairSeries(
        'real-key-123456',
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/broker-native fallback failed/);
  });

  it('rejects the shared Twelve Data demo key for production evidence', async () => {
    const collector = createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'demo',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn() } as unknown as ExecutionService,
      { getCurrentPriceForConnection: jest.fn() } as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
    await expect(collector.collectOnce(jest.fn() as unknown as typeof fetch)).rejects.toThrow(
      /production Twelve Data key/,
    );
  });
});

describe('scheduled scan recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T10:03:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  function scanner(dataSource?: any) {
    return createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      dataSource,
    );
  }
  function goodFeed() {
    return new Response(JSON.stringify(allTrendPayload()), { status: 200 });
  }
  it('carries forward only the missing recent compatible pair-side samples across a calibration policy bump', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        policy_version: 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1',
        realised_pnl: -1,
        closed_at: new Date('2026-10-12T09:55:00.000Z'),
      },
      {
        policy_version: 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1',
        realised_pnl: -1,
        closed_at: new Date('2026-10-12T09:50:00.000Z'),
      },
      {
        policy_version: 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
        realised_pnl: -1,
        closed_at: new Date('2026-10-12T09:45:00.000Z'),
      },
      {
        policy_version: 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
        realised_pnl: -1,
        closed_at: new Date('2026-10-12T09:40:00.000Z'),
      },
      {
        policy_version: 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
        realised_pnl: -1,
        closed_at: new Date('2026-10-12T09:35:00.000Z'),
      },
      {
        policy_version: 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
        realised_pnl: 10,
        closed_at: new Date('2026-10-12T09:30:00.000Z'),
      },
    ]);
    const collector = scanner({ query });

    const evidence = await (collector as any).loadPaperResearchPairSideEvidence(
      'user-1',
      'conn-1',
      'EURUSD',
      'SELL',
    );

    expect(evidence).toEqual({ wins: 0, losses: 5, realisedRSamples: 0, realisedRSum: 0 });
    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(params[5]).toEqual([
      'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1',
      'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1',
    ]);
    expect(params[6]).toBe('planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1');
  });

  it('uses the current policy sample history once it is self-sufficient and ignores predecessor losses', async () => {
    const currentPolicy = 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1';
    const previousPolicy = 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1';
    const query = jest.fn().mockResolvedValue([
      {
        policy_version: currentPolicy,
        realised_pnl: 2,
        closed_at: new Date('2026-10-12T09:59:00.000Z'),
      },
      {
        policy_version: currentPolicy,
        realised_pnl: 2,
        closed_at: new Date('2026-10-12T09:58:00.000Z'),
      },
      {
        policy_version: currentPolicy,
        realised_pnl: 2,
        closed_at: new Date('2026-10-12T09:57:00.000Z'),
      },
      {
        policy_version: currentPolicy,
        realised_pnl: 2,
        closed_at: new Date('2026-10-12T09:56:00.000Z'),
      },
      {
        policy_version: currentPolicy,
        realised_pnl: 2,
        closed_at: new Date('2026-10-12T09:55:00.000Z'),
      },
      {
        policy_version: currentPolicy,
        realised_pnl: -1,
        closed_at: new Date('2026-10-12T09:54:00.000Z'),
      },
      {
        policy_version: previousPolicy,
        realised_pnl: -5,
        closed_at: new Date('2026-10-12T09:53:00.000Z'),
      },
      {
        policy_version: previousPolicy,
        realised_pnl: -5,
        closed_at: new Date('2026-10-12T09:52:00.000Z'),
      },
    ]);
    const collector = scanner({ query });

    const evidence = await (collector as any).loadPaperResearchPairSideEvidence(
      'user-1',
      'conn-1',
      'AUDUSD',
      'SELL',
    );

    expect(evidence).toEqual({ wins: 5, losses: 1, realisedRSamples: 0, realisedRSum: 0 });
  });

  it('derives realised-R payoff from the selected pair-side trade geometry', async () => {
    const currentPolicy = 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1';
    const rows = [
      ...Array.from({ length: 3 }, (_, index) => ({
        policy_version: currentPolicy,
        realised_pnl: 2,
        fill_price: '1.1000',
        exit_price: '1.0995',
        stop_loss: '1.1010',
        closed_at: new Date(Date.UTC(2026, 9, 12, 9, 59 - index, 0)),
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        policy_version: currentPolicy,
        realised_pnl: -4,
        fill_price: '1.1000',
        exit_price: '1.1010',
        stop_loss: '1.1010',
        closed_at: new Date(Date.UTC(2026, 9, 12, 9, 56 - index, 0)),
      })),
    ];
    const query = jest.fn().mockResolvedValue(rows);
    const collector = scanner({ query });

    const evidence = await (collector as any).loadPaperResearchPairSideEvidence(
      'user-1',
      'conn-1',
      'EURUSD',
      'SELL',
    );

    expect(evidence).toMatchObject({
      wins: 3,
      losses: 2,
      realisedRSamples: 5,
    });
    expect(evidence.realisedRSum).toBeCloseTo(-0.5, 10);
    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('t.fill_price');
    expect(sql).toContain('t.exit_price');
    expect(sql).toContain('t.stop_loss');
  });

  it('expires compatible pair-side carry-forward evidence after seven days', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const collector = scanner({ query });

    await (collector as any).loadPaperResearchPairSideEvidence('user-1', 'conn-1', 'USDJPY', 'BUY');

    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain("INTERVAL '7 days'");
    expect(sql).not.toContain("INTERVAL '24 hours'");
  });

  it('caps self-sufficient current-policy pair-side evidence at twenty samples', async () => {
    const currentPolicy = 'planb-v4-bi2-et2-nm2-hp3-dmw2-ts1-trr1-psrr1-cal1';
    const rows = Array.from({ length: 21 }, (_, index) => ({
      policy_version: currentPolicy,
      realised_pnl: 1,
      closed_at: new Date(Date.UTC(2026, 9, 12, 9, 59 - index, 0)),
    }));
    const query = jest.fn().mockResolvedValue(rows);
    const collector = scanner({ query });

    const evidence = await (collector as any).loadPaperResearchPairSideEvidence(
      'user-1',
      'conn-1',
      'USDCAD',
      'BUY',
    );

    expect(evidence).toEqual({ wins: 20, losses: 0, realisedRSamples: 0, realisedRSum: 0 });
  });

  it('filters break-even trades before applying the pair-side reliability row cap', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const collector = scanner({ query });

    await (collector as any).loadPaperResearchPairSideEvidence(
      'user-1',
      'conn-1',
      'EURUSD',
      'SELL',
    );

    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('AND t.realised_pnl <> 0');
  });

  it('evaluates the current closed-bar slot after a restart between boundaries, only once per slot', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => goodFeed());
    const collector = scanner();
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe('2026-10-12T10:03:00.000Z');
    jest.setSystemTime(new Date('2026-10-12T10:04:15.000Z'));
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe('2026-10-12T10:03:00.000Z');
    jest.setSystemTime(new Date('2026-10-12T10:05:00.000Z'));
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe('2026-10-12T10:05:00.000Z');
  });
  it('recovers a failed slot after one minute without retrying on every 15-second timer tick', async () => {
    jest.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'feed unavailable' }), { status: 503 }),
      )
      .mockImplementation(async () => goodFeed());
    const collector = scanner();
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBeNull();
    jest.setSystemTime(new Date('2026-10-12T10:00:15.000Z'));
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBeNull();
    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe('2026-10-12T10:01:00.000Z');
  });
  it('keeps the deterministic signal id stable for an identical identity-bound decision', () => {
    const collector = scanner();
    const derive = (collector as any).materialSignalIdFor;
    expect(typeof derive).toBe('function');
    const material = {
      opportunityKey: 'irexpro-multimodel-ensemble-v1|AUDUSD|2026-10-16T08:20:00.000Z|SELL',
      instrument: 'AUDUSD',
      direction: 'SELL',
      requestedLotSize: '0.09',
      entryPrice: 0.65981,
      stopLoss: 0.66061,
      takeProfit: 0.65861,
      strategyCode: 'external-irexpro-multimodel-ensemble-v1',
      timeframe: 'M5',
      modelVersion:
        'external-provider/irexpro-multimodel-ensemble-v1/paper-research-throughput-v10-evidence-backed-acceleration',
    };

    expect(derive.call(collector, material)).toBe(derive.call(collector, { ...material }));
  });

  it('changes the deterministic signal id whenever identity-bound execution material changes', () => {
    const collector = scanner();
    const derive = (collector as any).materialSignalIdFor;
    expect(typeof derive).toBe('function');
    const material = {
      opportunityKey: 'irexpro-multimodel-ensemble-v1|AUDUSD|2026-10-16T08:20:00.000Z|SELL',
      instrument: 'AUDUSD',
      direction: 'SELL',
      requestedLotSize: '0.09',
      entryPrice: 0.65981,
      stopLoss: 0.66061,
      takeProfit: 0.65861,
      strategyCode: 'external-irexpro-multimodel-ensemble-v1',
      timeframe: 'M5',
      modelVersion:
        'external-provider/irexpro-multimodel-ensemble-v1/paper-research-throughput-v10-evidence-backed-acceleration',
    };
    const original = derive.call(collector, material);
    const revisions = [
      { requestedLotSize: '0.08' },
      { entryPrice: 0.65982 },
      { stopLoss: 0.66062 },
      { takeProfit: 0.65862 },
      { modelVersion: 'external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1' },
    ];

    for (const revision of revisions) {
      expect(derive.call(collector, { ...material, ...revision })).not.toBe(original);
    }
  });

  it('does not reopen the same M5 slot when broker fallback is known unavailable', async () => {
    jest.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    const collector = scanner();
    const fallbackUnavailable = Object.assign(new Error('fallback source is SUSPENDED'), {
      code: 'BROKER_FALLBACK_SOURCE_UNAVAILABLE',
    });
    const collectSpy = jest.spyOn(collector, 'collectOnce').mockRejectedValue(fallbackUnavailable);

    await collector.maybeCollect();
    expect(collectSpy).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    await collector.maybeCollect();
    expect(collectSpy).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-10-12T10:05:00.000Z'));
    await collector.maybeCollect();
    expect(collectSpy).toHaveBeenCalledTimes(2);
  });

  it('pins the exact producer generatedAt across the one-minute retry window', async () => {
    jest.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    const query = jest.fn().mockResolvedValue([]);
    const collector = scanner({ query });
    const resolveDelivery = (collector as any).resolveSignalDeliveryTimestamp;
    expect(typeof resolveDelivery).toBe('function');

    const first = await resolveDelivery.call(collector, 'user-1', 'signal-1');
    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    const retry = await resolveDelivery.call(collector, 'user-1', 'signal-1');

    expect(first.deliver).toBe(true);
    expect(retry.deliver).toBe(true);
    expect(retry.generatedAt.toISOString()).toBe(first.generatedAt.toISOString());
  });

  it('reuses the durable original generatedAt after restart while the identity is still fresh', async () => {
    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    const query = jest
      .fn()
      .mockResolvedValue([{ generated_at: new Date('2026-10-12T10:00:30.000Z') }]);
    const collector = scanner({ query });

    const delivery = await (collector as any).resolveSignalDeliveryTimestamp('user-1', 'signal-1');

    expect(delivery).toMatchObject({ deliver: true, reason: 'DURABLE_RETRY_IDENTITY_REUSED' });
    expect(delivery.generatedAt.toISOString()).toBe('2026-10-12T10:00:30.000Z');
  });

  it('suppresses an already-evaluated market event after the signal freshness window', async () => {
    jest.setSystemTime(new Date('2026-10-12T10:05:00.000Z'));
    const query = jest
      .fn()
      .mockResolvedValue([{ generated_at: new Date('2026-10-12T10:00:00.000Z') }]);
    const collector = scanner({ query });

    const delivery = await (collector as any).resolveSignalDeliveryTimestamp('user-1', 'signal-1');

    expect(delivery).toMatchObject({
      deliver: false,
      generatedAt: null,
      reason: 'MARKET_EVENT_ALREADY_EVALUATED',
    });
  });

  it('classifies only the proven TradeIntent persistence failure as retry-safe', () => {
    const collector = scanner();
    const classify = (
      collector as unknown as {
        retrySafePreIntentErrorForOutcome(outcome: {
          outcome: string;
          signalId: string;
          reason?: string;
        }): (Error & { code: string }) | null;
      }
    ).retrySafePreIntentErrorForOutcome;
    expect(typeof classify).toBe('function');

    const retrySafe = classify.call(collector, {
      outcome: 'EXECUTION_FAILED',
      signalId: 'signal-1',
      reason: 'Trade intent could not be recorded (fail-closed): database unavailable',
    });
    expect(retrySafe?.code).toBe('PAPER_PRE_INTENT_RETRY_SAFE');

    expect(
      classify.call(collector, {
        outcome: 'EXECUTION_FAILED',
        signalId: 'signal-1',
        reason: 'Provider dispatch error: timeout',
      }),
    ).toBeNull();
    expect(
      classify.call(collector, {
        outcome: 'RISK_REJECTED',
        signalId: 'signal-1',
        reason: 'risk veto',
      }),
    ).toBeNull();
  });

  it('retries a proven pre-intent failure only once within the same scan slot', async () => {
    jest.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
    const collector = scanner();
    const retrySafeError = Object.assign(new Error('trade intent unavailable'), {
      code: 'PAPER_PRE_INTENT_RETRY_SAFE',
    });
    const collectSpy = jest.spyOn(collector, 'collectOnce').mockRejectedValue(retrySafeError);

    await collector.maybeCollect();
    expect(collectSpy).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    await collector.maybeCollect();
    expect(collectSpy).toHaveBeenCalledTimes(2);

    jest.setSystemTime(new Date('2026-10-12T10:02:00.000Z'));
    await collector.maybeCollect();
    expect(collectSpy).toHaveBeenCalledTimes(2);
  });

  it('cancels the pending initial scan when the scanner is destroyed', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => goodFeed());
    const collector = scanner();
    await collector.onModuleInit();
    const primedAt = (await collector.getStatus('user-1')).lastEvaluatedAt;
    collector.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(2_000);
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBe(primedAt);
  });
  it('keeps recovery paused during the weekend', async () => {
    jest.setSystemTime(new Date('2026-10-10T10:03:00.000Z'));
    jest.spyOn(global, 'fetch').mockImplementation(async () => goodFeed());
    const collector = scanner();
    await collector.maybeCollect();
    expect((await collector.getStatus('user-1')).lastEvaluatedAt).toBeNull();
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('NONE');
  });
});

describe('transient primary-feed failover', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());
  function scanner(brokerOverrides: Partial<BrokerService> = {}) {
    const broker = {
      findConnectionById: jest
        .fn()
        .mockResolvedValue({ brokerId: 'metatrader5', status: 'CONNECTED' }),
      getOhlcvForConnection: jest
        .fn()
        .mockImplementation(async (_u: string, _c: string, instrument: string) =>
          trendCandles(instrument === 'USDJPY' ? 157 : 1.1, instrument === 'USDJPY' ? 3 : 5),
        ),
      ...brokerOverrides,
    } as unknown as BrokerService;
    return createCollector(
      config({
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.apiKey': 'real-key-123456',
        'vpsForexScanner.userId': 'user-1',
        'vpsForexScanner.brokerConnectionId': 'conn-1',
        'multimodelBrokerExpert.enabled': true,
        'multimodelBrokerExpert.sourceConnectionId': 'metaapi-demo-1',
      }),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
      broker,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
    );
  }
  async function assertFallback(fetchImpl: typeof fetch) {
    const collector = scanner();
    const series = await (collector as any).fetchSixPairSeries('real-key-123456', fetchImpl);
    expect([...series.keys()].sort()).toEqual(PAIRS.map(([p]) => p).sort());
    for (const candles of series.values()) {
      expect(candles.length).toBeGreaterThanOrEqual(55);
      expect(
        candles.every((c: { timestamp: Date }) => c.timestamp.getTime() + 300_000 <= Date.now()),
      ).toBe(true);
    }
    const status = await collector.getStatus('user-1');
    expect(status.marketDataAuthority).toBe('METAAPI_BROKER_FALLBACK');
    expect(status.providerCooldownReason).toBeNull();
    expect(status.executionAuthority).toBe('PAPER_ONLY');
  }
  it.each([429, 502, 503])('uses validated broker candles on transient HTTP %s', async (status) => {
    await assertFallback(
      async () =>
        new Response(JSON.stringify({ message: 'temporary provider limit or outage' }), { status }),
    );
  });
  it('uses validated broker candles when the provider request times out', async () => {
    await assertFallback((async () => {
      throw new Error('request timeout');
    }) as typeof fetch);
  });
  it('uses validated broker candles when the provider returns malformed JSON', async () => {
    await assertFallback(async () => new Response('{invalid', { status: 200 }));
  });
  it('uses one coherent broker batch when the primary batch omits an instrument', async () => {
    const batch = allTrendPayload();
    delete batch['USD/JPY'];
    await assertFallback(async () => new Response(JSON.stringify(batch), { status: 200 }));
  });
  it('uses validated broker candles when a primary instrument is stale', async () => {
    const batch = allTrendPayload();
    batch['EUR/USD'].values = batch['EUR/USD'].values.map((c: { datetime: string }) => ({
      ...c,
      datetime: new Date(new Date(c.datetime.replace(' ', 'T') + 'Z').getTime() - 3_600_000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' '),
    }));
    await assertFallback(async () => new Response(JSON.stringify(batch), { status: 200 }));
  });
  it('keeps authentication failures explicit instead of hiding configuration errors with fallback', async () => {
    const collector = scanner();
    await expect(
      (collector as any).fetchSixPairSeries(
        'real-key-123456',
        async () => new Response(JSON.stringify({ message: 'invalid API key' }), { status: 401 }),
      ),
    ).rejects.toThrow('Twelve Data HTTP 401');
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('NONE');
  });
  it('fails over on a JSON null payload rather than throwing a parser-shape error', async () => {
    await assertFallback(async () => new Response('null', { status: 200 }));
  });
  it('does not hide an authentication failure when its response body is not JSON', async () => {
    const collector = scanner();
    await expect(
      (collector as any).fetchSixPairSeries(
        'real-key-123456',
        async () => new Response('unauthorized', { status: 401 }),
      ),
    ).rejects.toThrow('Twelve Data HTTP 401');
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('NONE');
  });
  it('limits primary requests to one per minute even when both providers fail', async () => {
    const collector = scanner({
      getOhlcvForConnection: jest.fn().mockRejectedValue(new Error('broker unavailable')),
    });
    let primaryRequests = 0;
    const unavailableFeed = async () => {
      primaryRequests += 1;
      return new Response(JSON.stringify({ message: 'temporarily unavailable' }), { status: 503 });
    };
    await expect(
      (collector as any).fetchSixPairSeries('real-key-123456', unavailableFeed),
    ).rejects.toThrow('broker-native fallback failed');
    await expect(
      (collector as any).fetchSixPairSeries('real-key-123456', unavailableFeed),
    ).rejects.toThrow('broker-native fallback failed');
    expect(primaryRequests).toBe(1);
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('NONE');
    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    await expect(
      (collector as any).fetchSixPairSeries('real-key-123456', unavailableFeed),
    ).rejects.toThrow('broker-native fallback failed');
    expect(primaryRequests).toBe(2);
  });
  it('treats current-minute credit wording as a minute limit, not a daily cooldown', async () => {
    await assertFallback(
      async () =>
        new Response(
          JSON.stringify({
            message:
              'You have run out of API credits for the current minute. 12 API credits were used, with the current limit being 8.',
          }),
          { status: 429 },
        ),
    );
  });
  it('tries the primary provider again in the next minute after a minute-limit fallback', async () => {
    const collector = scanner();
    await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      async () =>
        new Response(
          JSON.stringify({
            message:
              'You have run out of API credits for the current minute, with the current limit being 8.',
          }),
          { status: 429 },
        ),
    );
    jest.setSystemTime(new Date('2026-10-12T10:01:00.000Z'));
    await (collector as any).fetchSixPairSeries(
      'real-key-123456',
      async () => new Response(JSON.stringify(allTrendPayload()), { status: 200 }),
    );
    expect((await collector.getStatus('user-1')).marketDataAuthority).toBe('TWELVE_DATA');
    expect((await collector.getStatus('user-1')).providerCooldownUntil).toBeNull();
  });
  it.each([null, { open: '1.1' }])(
    'uses a coherent broker batch when a primary candle row is malformed (%s)',
    async (badRow) => {
      const batch = allTrendPayload();
      batch['EUR/USD'].values[0] = badRow;
      await assertFallback(async () => new Response(JSON.stringify(batch), { status: 200 }));
    },
  );
});

describe('PAPER post-loss history availability', () => {
  it.each([undefined, { query: jest.fn().mockResolvedValue([]) }])(
    'holds when the history store is missing or fails to return its anchored row',
    async (dataSource) => {
      const context = { dataSource, logger: { warn: jest.fn() } };
      const state = await VpsForexSignalCollectorService.prototype[
        'loadPaperPostLossEntryState'
      ].call(context, 'user', 'connection', 'EURUSD', 'BUY');
      expect(state).toEqual({ available: false, lastClosedTrade: null });
    },
  );
});

describe('PAPER shadow local-edge pocket evidence loader', () => {
  it('loads an exact active-policy causal pocket and returns its support decision', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        samples: '44',
        wins: '31',
        losses: '13',
        gross_profit_r: '40.2',
        gross_loss_r: '14.33',
        net_r: '25.87',
        average_net_r: '0.588',
        profit_factor: '2.542',
        recent_samples: '8',
        recent_wins: '8',
        recent_net_r: '10.98',
        latest_resolved_at: '2026-10-23T20:40:00.000Z',
      },
    ]);
    const collector = Object.create(VpsForexSignalCollectorService.prototype) as any;
    collector.dataSource = { query };
    const evaluatedAt = new Date('2026-10-23T20:55:00.000Z');

    await expect(
      collector.loadPaperShadowLocalEdgePocketEvidence(
        'user-1',
        'conn-1',
        'GBPUSD',
        'SELL',
        'NEW_YORK',
        'DISLOCATED',
        'TREND_CONTINUATION',
        evaluatedAt,
      ),
    ).resolves.toMatchObject({
      supported: true,
      state: 'SUPPORTED',
      samples: 44,
      recentWins: 8,
      recentNetR: 10.98,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain('model_version = $4');
    expect(String(sql)).toContain("components->>'strategyRoute' = $8");
    expect(String(sql)).toContain("components->'outcome'->>'version' = $9");
    expect(String(sql)).toContain('evaluated_at < $10');
    expect(String(sql)).toContain('resolved_at < $10');
    expect(params).toEqual([
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      PlanBEnsembleModule.PLAN_B_ACTIVE_MODEL_POLICY_VERSION,
      'GBPUSD',
      'SELL',
      'NEW_YORK',
      'TREND_CONTINUATION',
      ENSEMBLE_OUTCOME_MODEL_VERSION,
      evaluatedAt,
      'DISLOCATED',
    ]);
  });
});
