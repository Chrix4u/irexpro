import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v5 as uuidv5 } from 'uuid';
import { ExecutionService } from '../execution/execution.service';
import { TradeIntentService } from '../execution/services/trade-intent.service';
import { AllocationService } from '../execution/services/allocation.service';
import { PAPER_PRODUCT_ABSOLUTE_MIN_LOT } from '../execution/services/position-sizing.service';
import { ExecutionMode } from '../execution/interfaces/execution-authority';
import { AiSignalService } from './ai-signal.service';
import { MacroEventRiskService } from './macro-event-risk.service';
import {
  M1_SHADOW_OUTCOME_15M_ARTIFACT,
  M1TacticalEvidenceService,
  type M1ShadowOutcome15mV1,
} from './m1-tactical-evidence.service';
import {
  M1TacticalMarketDataService,
  type M1TacticalMarketReadiness,
} from './m1-tactical-market-data.service';
import {
  buildM1TacticalCandidates,
  M1_TACTICAL_POLICY_V1,
  type M1TacticalCandidate,
} from './m1-tactical-candidate';
import { buildM1TacticalFeatures } from './m1-tactical-features';
import {
  classifyM1TacticalRoute,
  type M1TacticalRoute,
  type M1TacticalRouteDecision,
} from './m1-tactical-route';
import { evaluateM1TacticalGovernance } from './m1-tactical-governance';
import { evaluateM1TacticalExpectancy } from './m1-tactical-expectancy';
import {
  evaluateM1RoutePairSideReliability,
  type M1ReliabilityRoute,
} from './m1-tactical-reliability';
import { isFxWeeklySessionOpen } from '../market-data/utils/fx-weekly-session';
import { evaluateM1DriftCounterfactual15m } from './m1-drift-counterfactual';
import { evaluateM1CausalOutcome15m } from './m1-causal-outcome';
import {
  evaluateM1FailedMoveRescue,
  type M1FailedMoveRescueInput,
  type M1FailedMoveRescueDecision,
} from './m1-failed-move-rescue';
import {
  evaluateM1ShadowPairSideReliability,
  M1_SHADOW_MICRO_RELIABILITY_ARTIFACT,
  type M1ShadowPairSideReliabilityDecision,
} from './m1-shadow-pair-side-reliability';
import {
  evaluateM1MeaningfulScoutReliability,
  M1_MEANINGFUL_SCOUT_MIN_SAMPLES,
  M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT,
  type M1MeaningfulScoutReliabilityDecision,
} from './m1-meaningful-scout-reliability';
import {
  evaluateM1ProvisionalScoutReliability,
  M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT,
  type M1ProvisionalScoutReliabilityDecision,
} from './m1-provisional-scout-reliability';
import {
  evaluateM1TacticalCurrencyExposure,
  m1UsdRiskAtStop,
  type M1CurrencyExposureDecision,
} from './m1-tactical-currency-exposure';

type M1ScoutPairSideReliabilityDecision =
  | M1ShadowPairSideReliabilityDecision
  | M1MeaningfulScoutReliabilityDecision
  | M1ProvisionalScoutReliabilityDecision;

export type M1TacticalExecutionPhase =
  | 'SHADOW'
  | 'PAPER_CONTINUATION'
  | 'PAPER_ALL_ROUTES'
  | 'PAPER_EARLY_TRANSITION_MICRO'
  | 'PAPER_EARLY_TRANSITION_SCOUT_010'
  | 'PAPER_EARLY_TRANSITION_SCOUT_TIERED';

export interface M1TacticalRolloutPolicy {
  version: string;
  phase: M1TacticalExecutionPhase;
  cadenceMs: number;
  instruments: readonly string[];
  paperVolumeCap: number;
  routeNetExpectedRFloors: Readonly<Record<Exclude<M1TacticalRoute, 'ABSTAIN'>, number>>;
}

export interface M1OpenPositionRescueShadowInput {
  decisionId: string;
  userId: string;
  brokerConnectionId: string;
  instrument: string;
  originalDirection: 'BUY' | 'SELL';
  oppositeDirection: 'BUY' | 'SELL';
  originalInvalidated: boolean;
  originalNetExpectedR: number;
  oppositeNetExpectedR: number;
  oppositeGovernanceEligible: boolean;
  oppositeBlockers: readonly string[];
  observedAt?: Date;
}

export const M1_TACTICAL_ROLLOUT_POLICY_TOKEN = 'M1_TACTICAL_ROLLOUT_POLICY';
export const M1_TACTICAL_ROLLOUT_POLICY_V1: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  version: 'm1-tactical-rollout-v1',
  phase: 'SHADOW',
  cadenceMs: 15_000,
  instruments: Object.freeze(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF']),
  paperVolumeCap: 0.05,
  routeNetExpectedRFloors: Object.freeze({
    M1_TREND_CONTINUATION: 0.08,
    M1_CONFIRMED_REVERSAL: 0.12,
    M1_EARLY_TRANSITION: 0.2,
  }),
});

export const M1_TACTICAL_ROLLOUT_POLICY_V2: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v2',
  phase: 'PAPER_CONTINUATION',
});

export const M1_TACTICAL_ROLLOUT_POLICY_V3: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V2,
  version: 'm1-tactical-rollout-v3',
  phase: 'PAPER_ALL_ROUTES',
});

export const M1_TACTICAL_ROLLOUT_POLICY_V4: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v4-early-transition-micro',
  phase: 'PAPER_EARLY_TRANSITION_MICRO',
  paperVolumeCap: 0.01,
});

export const M1_TACTICAL_ROLLOUT_POLICY_V5: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v5-meaningful-size-shadow',
  phase: 'SHADOW',
  paperVolumeCap: 0.2,
});

export const M1_TACTICAL_ROLLOUT_POLICY_V6: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v6-early-transition-scout-010',
  phase: 'PAPER_EARLY_TRANSITION_SCOUT_010',
  paperVolumeCap: 0.1,
});

export const M1_TACTICAL_ROLLOUT_POLICY_V7: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  ...M1_TACTICAL_ROLLOUT_POLICY_V1,
  version: 'm1-tactical-rollout-v7-early-transition-tiered-scout',
  phase: 'PAPER_EARLY_TRANSITION_SCOUT_TIERED',
  paperVolumeCap: 0.1,
});

export function m1RiskMarketRegime(
  route: M1TacticalRoute,
): 'TREND_HEALTHY' | 'REVERSAL' | 'TRANSITION' | undefined {
  switch (route) {
    case 'M1_TREND_CONTINUATION':
      return 'TREND_HEALTHY';
    case 'M1_CONFIRMED_REVERSAL':
      return 'REVERSAL';
    case 'M1_EARLY_TRANSITION':
      return 'TRANSITION';
    case 'ABSTAIN':
    default:
      return undefined;
  }
}

export function m1RouteExecutableInPhase(
  phase: M1TacticalExecutionPhase,
  route: M1TacticalRoute,
): boolean {
  if (phase === 'SHADOW' || route === 'ABSTAIN') return false;
  if (phase === 'PAPER_CONTINUATION') return route === 'M1_TREND_CONTINUATION';
  if (
    phase === 'PAPER_EARLY_TRANSITION_MICRO' ||
    phase === 'PAPER_EARLY_TRANSITION_SCOUT_010' ||
    phase === 'PAPER_EARLY_TRANSITION_SCOUT_TIERED'
  )
    return route === 'M1_EARLY_TRANSITION';
  return (
    route === 'M1_TREND_CONTINUATION' ||
    route === 'M1_CONFIRMED_REVERSAL' ||
    route === 'M1_EARLY_TRANSITION'
  );
}

export function m1ShadowOutcomeEligible(input: {
  routeEligible: boolean;
  route: M1TacticalRoute;
  routeReason: string;
  routePayoffEligible: boolean;
  blockers: readonly string[];
  eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED';
  paperExecutionCostUsable: boolean;
}): boolean {
  if (!input.routeEligible || input.route === 'ABSTAIN' || !input.routePayoffEligible) return false;
  if (input.eventRisk !== 'CLEAR' || !input.paperExecutionCostUsable) return false;

  const hardBlockers = input.blockers.filter((blocker) => !blocker.startsWith('M1_RELIABILITY_'));
  if (hardBlockers.length === 0) return true;

  return (
    input.route === 'M1_EARLY_TRANSITION' &&
    input.routeReason === 'LOCAL_IMPULSE_AGAINST_HTF' &&
    hardBlockers.length === 1 &&
    hardBlockers[0] === 'DRIFT_OUT_OF_DISTRIBUTION'
  );
}

const M1_SIGNAL_NAMESPACE = 'df913329-57f7-4c08-8f19-8272540b7efd';

function minuteBoundary(now: Date): Date {
  const value = now.getTime();
  return new Date(Math.floor(value / 60_000) * 60_000);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

@Injectable()
export class M1TacticalSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(M1TacticalSchedulerService.name);
  private readonly rolloutPolicy: Readonly<M1TacticalRolloutPolicy>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private destroyed = false;
  private lastSlotKey: string | null = null;
  private lastRunAt: Date | null = null;
  private lastError: string | null = null;
  private readonly marketReadiness = new Map<string, M1TacticalMarketReadiness>();

  constructor(
    private readonly config: ConfigService,
    private readonly marketData: M1TacticalMarketDataService,
    private readonly macroEventRisk: MacroEventRiskService,
    private readonly evidence: M1TacticalEvidenceService,
    private readonly aiSignalService: AiSignalService,
    @Optional()
    @Inject(M1_TACTICAL_ROLLOUT_POLICY_TOKEN)
    rolloutPolicy?: M1TacticalRolloutPolicy,
    @Optional() private readonly executionService?: ExecutionService,
    @Optional() private readonly tradeIntentService?: TradeIntentService,
    @Optional() private readonly allocationService?: AllocationService,
  ) {
    this.rolloutPolicy = rolloutPolicy ?? M1_TACTICAL_ROLLOUT_POLICY_V1;
  }

  onModuleInit(): void {
    this.destroyed = false;
    if (!this.enabled()) {
      this.logger.log(
        'M1 tactical scheduler disabled because the VPS PAPER scanner binding is unavailable',
      );
      return;
    }
    this.logger.log(
      `M1 tactical scheduler enabled phase=${this.rolloutPolicy.phase} cadence=${this.rolloutPolicy.cadenceMs / 1000}s authority=${this.rolloutPolicy.phase === 'SHADOW' ? 'NONE' : 'PAPER_ONLY_RESEARCH'}`,
    );
    this.timer = setInterval(() => void this.runOnce(), this.rolloutPolicy.cadenceMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      policyVersion: this.rolloutPolicy.version,
      modelPolicyVersion: M1_TACTICAL_POLICY_V1.version,
      phase: this.rolloutPolicy.phase,
      cadenceSeconds: this.rolloutPolicy.cadenceMs / 1000,
      instruments: [...this.rolloutPolicy.instruments],
      running: this.running,
      lastSlotKey: this.lastSlotKey,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastError: this.lastError,
      marketReadiness: Object.fromEntries(
        [...this.marketReadiness.entries()].map(([instrument, readiness]) => [
          instrument,
          { ...readiness },
        ]),
      ),
      m5Independent: true as const,
    };
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.destroyed || this.running || !this.enabled()) return;
    if (!Number.isFinite(now.getTime()) || !isFxWeeklySessionOpen(now)) return;
    const decisionTime = minuteBoundary(now);
    const slotKey = decisionTime.toISOString();
    if (this.lastSlotKey === slotKey) return;

    // Claim this completed-minute slot before I/O. A provider failure must not
    // create a tight retry loop inside the same minute; the next slot is a new
    // causal decision boundary.
    this.lastSlotKey = slotKey;
    this.running = true;
    try {
      const userId = this.userId();
      const brokerConnectionId = this.connectionId();
      for (const instrument of this.rolloutPolicy.instruments) {
        try {
          await this.processInstrument(userId, brokerConnectionId, instrument, decisionTime);
        } catch (error) {
          this.logger.warn(
            `M1 tactical ${instrument} slot=${slotKey} failed closed: ${(error as Error).message}`,
          );
        }
      }
      this.lastRunAt = new Date(now);
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.warn(`M1 tactical slot=${slotKey} failed closed: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }

  private async processInstrument(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
    decisionTime: Date,
  ): Promise<void> {
    const market = await this.marketData.loadSnapshot(brokerConnectionId, instrument, decisionTime);
    const readiness = this.marketData.getLastReadiness?.(brokerConnectionId, instrument) ?? null;
    if (readiness) {
      const previous = this.marketReadiness.get(instrument);
      this.marketReadiness.set(instrument, { ...readiness });
      if (previous?.reason !== readiness.reason || previous?.ready !== readiness.ready) {
        this.logger.log(
          `M1 tactical readiness instrument=${instrument} ready=${readiness.ready} ` +
            `reason=${readiness.reason} authority=${readiness.authority ?? 'NONE'}`,
        );
      }
    }
    if (!market) return;

    const features = buildM1TacticalFeatures({
      instrument: market.instrument,
      decisionTime: market.decisionTime,
      m1: market.m1,
      m5: market.m5,
      m15: market.m15,
      h1: market.h1,
      h4: market.h4,
    });
    if (!features) return;

    const eventRisk = await this.macroEventRisk.assess(instrument, decisionTime);
    const candidates = buildM1TacticalCandidates(features, M1_TACTICAL_POLICY_V1);
    for (const [candidate, opposite] of [
      [candidates[0], candidates[1]],
      [candidates[1], candidates[0]],
    ] as const) {
      await this.persistCandidate(
        userId,
        brokerConnectionId,
        candidate,
        opposite,
        features,
        eventRisk.state,
        market.spreadEvidence,
        decisionTime,
        market.paperSimulationSpreadPrice,
      );
    }

    await this.settleMatureDriftCounterfactuals(
      userId,
      brokerConnectionId,
      instrument,
      decisionTime,
      market.m1,
    );
    await this.settleMatureShadowEpisodes(
      userId,
      brokerConnectionId,
      instrument,
      decisionTime,
      market.m1,
    );
  }

  private async settleMatureDriftCounterfactuals(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
    decisionTime: Date,
    m1Bars: Parameters<typeof evaluateM1DriftCounterfactual15m>[0]['bars'],
  ): Promise<void> {
    let pending: Awaited<ReturnType<M1TacticalEvidenceService['loadPendingDriftCounterfactuals']>>;
    try {
      pending = await this.evidence.loadPendingDriftCounterfactuals({
        userId,
        brokerConnectionId,
        instrument,
        asOf: decisionTime,
        policyVersion: M1_TACTICAL_POLICY_V1.version,
      });
    } catch (error) {
      this.logger.warn(
        `M1 drift counterfactual load deferred ${instrument}: ${(error as Error).message}`,
      );
      return;
    }

    for (const decision of pending) {
      const observation = evaluateM1DriftCounterfactual15m({
        direction: decision.direction,
        evaluatedAt: decision.evaluatedAt,
        stopDistance: decision.stopDistance,
        targetDistance: decision.targetDistance,
        executionCostR: decision.estimatedExecutionCostR,
        bars: m1Bars,
      });
      if (!observation) continue;
      try {
        await this.evidence.markDriftCounterfactual15m(decision.id, observation);
      } catch (error) {
        this.logger.warn(
          `M1 drift counterfactual settlement deferred decision=${decision.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async settleMatureShadowEpisodes(
    userId: string,
    brokerConnectionId: string,
    instrument: string,
    decisionTime: Date,
    m1Bars: Parameters<typeof evaluateM1CausalOutcome15m>[0]['bars'],
  ): Promise<void> {
    let leaders: Awaited<ReturnType<M1TacticalEvidenceService['loadMatureShadowEpisodeLeaders']>>;
    try {
      leaders = await this.evidence.loadMatureShadowEpisodeLeaders({
        userId,
        brokerConnectionId,
        instrument,
        policyVersion: M1_TACTICAL_POLICY_V1.version,
        asOf: decisionTime,
      });
    } catch (error) {
      this.logger.warn(
        `M1 shadow outcome load deferred ${instrument}: ${(error as Error).message}`,
      );
      return;
    }

    for (const leader of leaders) {
      const observation = evaluateM1CausalOutcome15m({
        direction: leader.direction,
        evaluatedAt: leader.evaluatedAt,
        stopDistance: leader.stopDistance,
        targetDistance: leader.targetDistance,
        executionCostR: leader.estimatedExecutionCostR,
        bars: m1Bars,
      });

      let outcome: M1ShadowOutcome15mV1 | null = null;
      if (observation) {
        outcome = {
          artifact: M1_SHADOW_OUTCOME_15M_ARTIFACT,
          modifiesExecution: false,
          episodeLeaderDecisionId: leader.id,
          episodeStartBarTime: leader.barTime.toISOString(),
          route: leader.route,
          instrument: leader.instrument,
          direction: leader.direction,
          policyVersion: leader.policyVersion,
          source: observation.source,
          executionCostSource: leader.executionCostSource,
          rolloutPhase: leader.rolloutPhase,
          outcome: observation.outcome,
          entryBarOpenTime: observation.entryBarOpenTime,
          observedAt: observation.observedAt,
          terminalBarOpenTime: observation.terminalBarOpenTime,
          entryPrice: observation.entryPrice,
          stopLoss: observation.stopLoss,
          takeProfit: observation.takeProfit,
          terminalPrice: observation.terminalPrice,
          estimatedExecutionCostR: observation.estimatedExecutionCostR,
          grossRMultiple: observation.grossRMultiple,
          netRMultiple: observation.netRMultiple,
        };
      } else if (decisionTime.getTime() - leader.evaluatedAt.getTime() > 60 * 60_000) {
        outcome = {
          artifact: M1_SHADOW_OUTCOME_15M_ARTIFACT,
          modifiesExecution: false,
          episodeLeaderDecisionId: leader.id,
          episodeStartBarTime: leader.barTime.toISOString(),
          route: leader.route,
          instrument: leader.instrument,
          direction: leader.direction,
          policyVersion: leader.policyVersion,
          source: 'UNOBSERVABLE_DATA_GAP',
          executionCostSource: leader.executionCostSource,
          rolloutPhase: leader.rolloutPhase,
          outcome: 'UNOBSERVABLE_DATA_GAP',
          entryBarOpenTime: null,
          observedAt: decisionTime.toISOString(),
          terminalBarOpenTime: null,
          entryPrice: null,
          stopLoss: null,
          takeProfit: null,
          terminalPrice: null,
          estimatedExecutionCostR: leader.estimatedExecutionCostR,
          grossRMultiple: null,
          netRMultiple: null,
        };
      }

      if (!outcome) continue;
      try {
        await this.evidence.markShadowOutcome15mV1(leader.id, outcome);
      } catch (error) {
        this.logger.warn(
          `M1 shadow outcome settlement deferred decision=${leader.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async persistCandidate(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    opposite: M1TacticalCandidate,
    features: ReturnType<typeof buildM1TacticalFeatures> & {},
    eventRisk: 'CLEAR' | 'HIGH_IMPACT_BLOCK' | 'UNVERIFIED',
    spreadEvidence: Parameters<typeof evaluateM1TacticalGovernance>[0]['executionSpreadEvidence'],
    decisionTime: Date,
    paperSimulationSpreadPrice?: number,
  ): Promise<void> {
    if (!features) return;
    const routeDecision = classifyM1TacticalRoute(
      candidate,
      opposite,
      features,
      M1_TACTICAL_POLICY_V1,
    );
    const reliability = await this.reliabilityFor(
      userId,
      brokerConnectionId,
      candidate,
      routeDecision,
      decisionTime,
    );
    const expectancy = evaluateM1TacticalExpectancy({
      targetR: candidate.grossExpectedR,
      confidence: candidate.confidence,
      directionQuality: candidate.directionQuality,
      reliability,
    });
    const governance = evaluateM1TacticalGovernance({
      candidate,
      routeDecision,
      features,
      eventRisk,
      evaluatedAt: decisionTime,
      executionSpreadEvidence: spreadEvidence,
      paperSimulationSpreadPrice,
      reliability,
      expectancy,
    });
    const shadowPairSideReliability = await this.shadowPairSideReliabilityFor(
      userId,
      brokerConnectionId,
      candidate,
      routeDecision,
      decisionTime,
    );

    const shadowOnly = this.rolloutPolicy.phase === 'SHADOW';
    const routeExecutable = m1RouteExecutableInPhase(this.rolloutPolicy.phase, routeDecision.route);
    const routeNetExpectedRFloor =
      routeDecision.route === 'ABSTAIN'
        ? Number.POSITIVE_INFINITY
        : this.rolloutPolicy.routeNetExpectedRFloors[routeDecision.route];
    const routePayoffEligible =
      routeDecision.route !== 'ABSTAIN' &&
      governance.expectancy.statisticalExpectedR >= routeNetExpectedRFloor;
    const shadowOutcomeEligible = m1ShadowOutcomeEligible({
      routeEligible: routeDecision.eligible,
      route: routeDecision.route,
      routeReason: routeDecision.reason,
      routePayoffEligible,
      blockers: governance.blockers,
      eventRisk,
      paperExecutionCostUsable: governance.genericGovernance.paperExecutionCostUsable === true,
    });
    const earlyTransitionMicro =
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_MICRO' &&
      routeDecision.route === 'M1_EARLY_TRANSITION';
    const earlyTransitionMeaningfulScout =
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_010' &&
      routeDecision.route === 'M1_EARLY_TRANSITION';
    const earlyTransitionTieredScout =
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_TIERED' &&
      routeDecision.route === 'M1_EARLY_TRANSITION';
    const evidenceQualifiedScout = earlyTransitionMeaningfulScout || earlyTransitionTieredScout;
    const scoutReliabilityArtifact = shadowPairSideReliability
      ? 'artifact' in shadowPairSideReliability
        ? shadowPairSideReliability.artifact
        : M1_SHADOW_MICRO_RELIABILITY_ARTIFACT
      : null;
    const meaningfulScoutReliability =
      shadowPairSideReliability &&
      'artifact' in shadowPairSideReliability &&
      shadowPairSideReliability.artifact === M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT
        ? shadowPairSideReliability
        : null;
    const provisionalScoutReliability =
      shadowPairSideReliability &&
      'artifact' in shadowPairSideReliability &&
      shadowPairSideReliability.artifact === M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT
        ? shadowPairSideReliability
        : null;
    const scoutReliabilityTier = earlyTransitionTieredScout
      ? provisionalScoutReliability
        ? 'PROVISIONAL'
        : meaningfulScoutReliability
          ? 'MATURE'
          : 'NONE'
      : earlyTransitionMeaningfulScout
        ? 'MATURE'
        : earlyTransitionMicro
          ? 'MICRO'
          : 'NONE';
    const executionVolumeCap = provisionalScoutReliability
      ? Math.min(this.rolloutPolicy.paperVolumeCap, provisionalScoutReliability.lotCap)
      : this.rolloutPolicy.paperVolumeCap;
    const microDriftOnlyRescue =
      earlyTransitionMicro &&
      shadowPairSideReliability?.eligible === true &&
      governance.blockers.length === 1 &&
      governance.blockers[0] === 'DRIFT_OUT_OF_DISTRIBUTION';
    const localImpulseDriftOnlyRescue =
      evidenceQualifiedScout &&
      routeDecision.reason === 'LOCAL_IMPULSE_AGAINST_HTF' &&
      shadowPairSideReliability?.eligible === true &&
      governance.blockers.length === 1 &&
      governance.blockers[0] === 'DRIFT_OUT_OF_DISTRIBUTION';
    const standardGovernanceExecutable =
      governance.paperEligible && governance.executionAuthority === 'PAPER_ONLY_RESEARCH';
    const governanceExecutable = earlyTransitionMicro
      ? shadowPairSideReliability?.eligible === true &&
        (standardGovernanceExecutable || microDriftOnlyRescue)
      : evidenceQualifiedScout
        ? shadowPairSideReliability?.eligible === true &&
          (standardGovernanceExecutable || localImpulseDriftOnlyRescue)
        : standardGovernanceExecutable;
    const canExecute = routeExecutable && routePayoffEligible && governanceExecutable;
    const effectiveGovernanceBlockers =
      microDriftOnlyRescue || localImpulseDriftOnlyRescue ? [] : governance.blockers;
    const blockers = unique([
      ...effectiveGovernanceBlockers,
      ...(earlyTransitionMicro && shadowPairSideReliability?.eligible !== true
        ? [`M1_SHADOW_RELIABILITY_${shadowPairSideReliability?.reason ?? 'UNAVAILABLE'}`]
        : []),
      ...(earlyTransitionMeaningfulScout && shadowPairSideReliability?.eligible !== true
        ? [`M1_MEANINGFUL_SCOUT_RELIABILITY_${shadowPairSideReliability?.reason ?? 'UNAVAILABLE'}`]
        : []),
      ...(earlyTransitionTieredScout && shadowPairSideReliability?.eligible !== true
        ? [`M1_TIERED_SCOUT_RELIABILITY_${shadowPairSideReliability?.reason ?? 'UNAVAILABLE'}`]
        : []),
      ...(routeExecutable && !routePayoffEligible ? ['M1_ROUTE_NET_EXPECTED_R_FLOOR'] : []),
      ...(shadowOnly ? ['M1_PHASE_SHADOW'] : []),
      ...(!shadowOnly && !routeExecutable && routeDecision.route !== 'ABSTAIN'
        ? ['M1_PHASE_ROUTE_SHADOW']
        : []),
    ]);

    const decision = await this.evidence.recordDecision({
      userId,
      brokerConnectionId,
      instrument: candidate.instrument,
      direction: candidate.direction,
      route: routeDecision.route,
      barTime: candidate.latestM1OpenTime,
      evaluatedAt: decisionTime,
      policyVersion: candidate.policyVersion,
      executionAuthority: canExecute ? 'PAPER_ONLY_RESEARCH' : 'NONE',
      candidate: { ...candidate },
      governance: {
        ...governance,
        routeDecision: { ...routeDecision },
        reliability: reliability ? { ...reliability } : null,
        shadowPairSideReliability: shadowPairSideReliability
          ? { artifact: scoutReliabilityArtifact, ...shadowPairSideReliability }
          : null,
        meaningfulScoutReliability:
          evidenceQualifiedScout && meaningfulScoutReliability
            ? { ...meaningfulScoutReliability }
            : null,
        provisionalScoutReliability:
          earlyTransitionTieredScout && provisionalScoutReliability
            ? { ...provisionalScoutReliability }
            : null,
        scoutReliabilityTier,
        executionVolumeCap,
        microDriftOnlyRescue,
        localImpulseDriftOnlyRescue,
        rolloutPolicyVersion: this.rolloutPolicy.version,
        rolloutPhase: this.rolloutPolicy.phase,
        routeNetExpectedRFloor,
        shadowOutcomeEligible,
      },
      blockers,
    });

    const executionAlreadyDurable =
      Boolean(decision.tradeIntentId) || decision.outcomeState === 'EXECUTION_SUCCEEDED';

    if (canExecute && !executionAlreadyDurable) {
      await this.submitPaperDecision(
        decision.id,
        userId,
        brokerConnectionId,
        candidate,
        routeDecision,
        governance,
        features,
        decisionTime,
        shadowPairSideReliability,
        microDriftOnlyRescue,
        localImpulseDriftOnlyRescue,
        evidenceQualifiedScout,
        scoutReliabilityTier,
        executionVolumeCap,
      );
    }
  }

  private async resolveM1CurrencyExposureGuard(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    requestedVolumeCap: number,
  ): Promise<{
    allowed: boolean;
    volumeCap: number;
    decision: M1CurrencyExposureDecision;
    productFloorBlocked: boolean;
  }> {
    const unavailable = evaluateM1TacticalCurrencyExposure({
      allocatedCapital: 0,
      positions: [],
      candidate: {
        instrument: candidate.instrument,
        direction: candidate.direction,
        riskAtStop: 0,
      },
    });
    if (!this.allocationService) {
      return { allowed: false, volumeCap: 0, decision: unavailable, productFloorBlocked: false };
    }

    let allocatedCapital = 0;
    try {
      const allocation = await this.allocationService.getUserCapitalAllocationState(
        userId,
        brokerConnectionId,
      );
      if (allocation.hasAllocation && allocation.allocatedCapital) {
        allocatedCapital = Number(allocation.allocatedCapital);
      }
    } catch {
      return { allowed: false, volumeCap: 0, decision: unavailable, productFloorBlocked: false };
    }

    let positions;
    try {
      positions = await this.evidence.loadOpenPaperRiskPositions({ userId, brokerConnectionId });
    } catch {
      const decision = evaluateM1TacticalCurrencyExposure({
        allocatedCapital,
        positions: [
          { instrument: candidate.instrument, direction: candidate.direction, riskAtStop: null },
        ],
        candidate: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          riskAtStop: 0,
        },
      });
      return { allowed: false, volumeCap: 0, decision, productFloorBlocked: false };
    }

    const evaluateAtVolume = (volume: number) => {
      const riskAtStop = m1UsdRiskAtStop({
        instrument: candidate.instrument,
        lotSize: volume,
        entryPrice: candidate.entry,
        stopLoss: candidate.stopLoss,
      });
      return evaluateM1TacticalCurrencyExposure({
        allocatedCapital,
        positions,
        candidate: {
          instrument: candidate.instrument,
          direction: candidate.direction,
          riskAtStop: riskAtStop ?? 0,
        },
      });
    };

    const productFloor = Number(PAPER_PRODUCT_ABSOLUTE_MIN_LOT);
    if (!Number.isFinite(productFloor) || productFloor <= 0) {
      return { allowed: false, volumeCap: 0, decision: unavailable, productFloorBlocked: false };
    }

    let volumeCap = requestedVolumeCap;
    let decision = evaluateAtVolume(volumeCap);

    if (!Number.isFinite(volumeCap) || volumeCap <= 0) {
      return { allowed: false, volumeCap: 0, decision, productFloorBlocked: false };
    }

    if (decision.capacity !== 'CLEAR') {
      if (volumeCap <= productFloor) {
        return { allowed: false, volumeCap: 0, decision, productFloorBlocked: true };
      }

      const floorDecision = evaluateAtVolume(productFloor);
      if (floorDecision.capacity !== 'CLEAR') {
        return {
          allowed: false,
          volumeCap: 0,
          decision: floorDecision,
          productFloorBlocked: true,
        };
      }

      volumeCap = productFloor;
      decision = floorDecision;
    }

    return {
      allowed: true,
      volumeCap,
      decision,
      productFloorBlocked: false,
    };
  }

  private async submitPaperDecision(
    decisionId: string,
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    routeDecision: M1TacticalRouteDecision,
    governance: ReturnType<typeof evaluateM1TacticalGovernance>,
    features: NonNullable<ReturnType<typeof buildM1TacticalFeatures>>,
    decisionTime: Date,
    shadowPairSideReliability: M1ScoutPairSideReliabilityDecision | null,
    microDriftOnlyRescue: boolean,
    localImpulseDriftOnlyRescue: boolean,
    evidenceQualifiedScout: boolean,
    scoutReliabilityTier: 'NONE' | 'MICRO' | 'PROVISIONAL' | 'MATURE',
    executionVolumeCap: number,
  ): Promise<void> {
    const session = this.executionService
      ? await this.executionService.getActiveSession(userId)
      : null;
    if (
      !session ||
      session.executionMode !== ExecutionMode.PAPER_ONLY ||
      session.brokerConnectionId !== brokerConnectionId
    ) {
      await this.evidence.markOutcomeState(
        decisionId,
        'SESSION_INACTIVE',
        new Date(),
        'M1 requires the exact active PAPER session bound to this broker connection',
      );
      return;
    }

    const currencyExposureGuard = await this.resolveM1CurrencyExposureGuard(
      userId,
      brokerConnectionId,
      candidate,
      executionVolumeCap,
    );
    if (!currencyExposureGuard.allowed) {
      const reason = currencyExposureGuard.productFloorBlocked
        ? `M1_CURRENCY_EXPOSURE_PRODUCT_FLOOR_BLOCKED requestedCap=${executionVolumeCap} ` +
          `productFloor=${PAPER_PRODUCT_ABSOLUTE_MIN_LOT} capacity=${currencyExposureGuard.decision.capacity} ` +
          `alignedRiskPercent=${currencyExposureGuard.decision.projectedAlignedRiskPercent}`
        : `M1_CURRENCY_EXPOSURE_BLOCKED capacity=${currencyExposureGuard.decision.capacity} ` +
          `alignedRiskPercent=${currencyExposureGuard.decision.projectedAlignedRiskPercent}`;
      this.logger.warn(
        `M1 tactical ${candidate.instrument} ${candidate.direction} execution=BLOCKED ${reason}`,
      );
      await this.evidence.markOutcomeState(decisionId, 'RISK_REJECTED', new Date(), reason);
      return;
    }
    const finalExecutionVolumeCap = currencyExposureGuard.volumeCap;

    const scoutReliabilityArtifact = shadowPairSideReliability
      ? 'artifact' in shadowPairSideReliability
        ? shadowPairSideReliability.artifact
        : M1_SHADOW_MICRO_RELIABILITY_ARTIFACT
      : null;
    const meaningfulScoutReliability =
      shadowPairSideReliability &&
      'artifact' in shadowPairSideReliability &&
      shadowPairSideReliability.artifact === M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT
        ? shadowPairSideReliability
        : null;
    const provisionalScoutReliability =
      shadowPairSideReliability &&
      'artifact' in shadowPairSideReliability &&
      shadowPairSideReliability.artifact === M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT
        ? shadowPairSideReliability
        : null;

    const signalIdentity = [
      userId,
      brokerConnectionId,
      candidate.instrument,
      candidate.direction,
      routeDecision.route,
      candidate.latestM1OpenTime.toISOString(),
      candidate.policyVersion,
    ].join('|');
    const signalId = uuidv5(signalIdentity, M1_SIGNAL_NAMESPACE);
    await this.evidence.markExecutionLink(decisionId, signalId, undefined);

    try {
      const result = await this.aiSignalService.receiveSignal({
        signalId,
        userId,
        tradingSessionId: session.id,
        brokerConnectionId,
        instrument: candidate.instrument,
        direction: candidate.direction,
        confidenceScore: candidate.confidence,
        suggestedEntryPrice: candidate.entry,
        suggestedStopLoss: candidate.stopLoss,
        suggestedTakeProfit: candidate.takeProfit,
        suggestedVolume: finalExecutionVolumeCap,
        timeframe: 'M1',
        strategyCode: 'external-irexpro-m1-tactical',
        marketRegime: m1RiskMarketRegime(routeDecision.route),
        volatilityScore: features.volatilityScore,
        generatedAt: new Date(decisionTime),
        modelVersion: `external-provider/irexpro-m1-tactical/${candidate.policyVersion}`,
        metadata: {
          external_provider_paper_only: true,
          production_eligible: false,
          position_sizing_tier: 'RESEARCH',
          m1_tactical_route: routeDecision.route,
          m1_policy_version: candidate.policyVersion,
          m1_rollout_policy_version: this.rolloutPolicy.version,
          m1_rollout_phase: this.rolloutPolicy.phase,
          m1_shadow_pair_side_reliability_artifact: scoutReliabilityArtifact,
          m1_shadow_pair_side_reliability_reason: shadowPairSideReliability?.reason ?? null,
          m1_shadow_pair_side_reliability_samples: shadowPairSideReliability?.samples ?? 0,
          m1_shadow_pair_side_reliability_average_r: shadowPairSideReliability?.averageNetR ?? null,
          m1_shadow_pair_side_reliability_profit_factor:
            shadowPairSideReliability?.profitFactor ?? null,
          m1_shadow_pair_side_reliability_positive_fraction:
            shadowPairSideReliability?.positiveFraction ?? null,
          m1_evidence_qualified_scout_eligible:
            evidenceQualifiedScout && shadowPairSideReliability?.eligible === true,
          m1_scout_reliability_tier: scoutReliabilityTier,
          m1_scout_requested_volume_cap: executionVolumeCap,
          m1_scout_execution_volume_cap: finalExecutionVolumeCap,
          m1_currency_exposure_capacity: currencyExposureGuard.decision.capacity,
          m1_currency_exposure_reason: currencyExposureGuard.decision.reason,
          m1_currency_exposure_projected_aligned_risk:
            currencyExposureGuard.decision.projectedAlignedRisk,
          m1_currency_exposure_projected_aligned_risk_percent:
            currencyExposureGuard.decision.projectedAlignedRiskPercent,
          m1_currency_exposure_allocated_capital: currencyExposureGuard.decision.allocatedCapital,
          m1_meaningful_scout_reliability_artifact: meaningfulScoutReliability
            ? M1_MEANINGFUL_SCOUT_RELIABILITY_ARTIFACT
            : null,
          m1_meaningful_scout_reliability_samples: meaningfulScoutReliability?.samples ?? 0,
          m1_meaningful_scout_reliability_recent_net_r:
            meaningfulScoutReliability?.recentNetR ?? null,
          m1_provisional_scout_reliability_artifact: provisionalScoutReliability
            ? M1_PROVISIONAL_SCOUT_RELIABILITY_ARTIFACT
            : null,
          m1_provisional_scout_reliability_samples: provisionalScoutReliability?.samples ?? 0,
          m1_provisional_scout_reliability_recent_net_r:
            provisionalScoutReliability?.recentNetR ?? null,
          m1_micro_drift_only_rescue: microDriftOnlyRescue,
          m1_local_impulse_drift_only_rescue: localImpulseDriftOnlyRescue,
          m1_decision_id: decisionId,
          m1_target_r_geometry: candidate.grossExpectedR,
          m1_expectancy_artifact: governance.expectancy.artifact,
          m1_expectancy_source: governance.expectancy.source,
          m1_heuristic_prior_expected_r: governance.expectancy.heuristicPriorExpectedR,
          m1_statistical_expected_r: governance.expectancy.statisticalExpectedR,
          m1_expectancy_implied_win_probability: governance.expectancy.impliedWinProbability,
          m1_expectancy_evidence_samples: governance.expectancy.evidenceSamples,
          m1_expectancy_evidence_average_realized_r: governance.expectancy.evidenceAverageRealizedR,
          m1_expectancy_recent_payoff_average_r: governance.expectancy.recentPayoffAverageR,
          m1_gross_expected_r: candidate.grossExpectedR,
          m1_execution_cost_r: governance.genericGovernance.estimatedExecutionCostR,
          m1_execution_cost_source: governance.genericGovernance.executionCostSource,
          m1_net_expected_r: governance.netExpectedR,
          m1_route_net_expected_r_floor:
            this.rolloutPolicy.routeNetExpectedRFloors[
              routeDecision.route as Exclude<M1TacticalRoute, 'ABSTAIN'>
            ],
          m1_execution_authority: 'PAPER_ONLY_RESEARCH',
        },
      });
      if (this.tradeIntentService) {
        try {
          const intent = await this.tradeIntentService.findBySignal(userId, signalId);
          if (intent?.id) {
            await this.evidence.markExecutionLink(decisionId, signalId, intent.id);
          }
        } catch (error) {
          this.logger.warn(
            `M1 decision ${decisionId} trade-intent audit linkage deferred: ${(error as Error).message}`,
          );
        }
      }
      await this.evidence.markOutcomeState(decisionId, result.outcome, new Date(), result.reason);
    } catch (error) {
      await this.evidence.markOutcomeState(
        decisionId,
        'EXECUTION_FAILED',
        new Date(),
        (error as Error).message,
      );
      throw error;
    }
  }

  async observeOpenPositionRescueShadow(
    input: M1OpenPositionRescueShadowInput,
  ): Promise<M1FailedMoveRescueDecision | null> {
    const instrument = input.instrument.trim().toUpperCase();
    const positions = await this.evidence.loadOpenPaperPositions({
      userId: input.userId,
      brokerConnectionId: input.brokerConnectionId,
      instrument,
    });
    const open = positions.find(
      (position) =>
        position.instrument === instrument && position.direction === input.originalDirection,
    );
    if (!open) return null;

    const duplicateOppositeIntent = await this.evidence.hasActiveOppositeM1Intent({
      userId: input.userId,
      brokerConnectionId: input.brokerConnectionId,
      instrument,
      direction: input.oppositeDirection,
    });
    const reversalAllowedByPolicy =
      this.rolloutPolicy.phase === 'PAPER_ALL_ROUTES' &&
      m1RouteExecutableInPhase(this.rolloutPolicy.phase, 'M1_CONFIRMED_REVERSAL');

    return this.recordFailedMoveRescueShadow(
      input.decisionId,
      {
        originalInvalidated: input.originalInvalidated,
        originalNetExpectedR: input.originalNetExpectedR,
        oppositeNetExpectedR: input.oppositeNetExpectedR,
        oppositeGovernanceEligible: input.oppositeGovernanceEligible,
        oppositeBlockers: input.oppositeBlockers,
        duplicateOppositeIntent,
        reversalAllowedByPolicy,
      },
      { openTradeId: open.tradeId, openDecisionId: open.decisionId },
      input.observedAt ?? new Date(),
    );
  }

  async recordFailedMoveRescueShadow(
    decisionId: string,
    input: M1FailedMoveRescueInput,
    linkage: { openTradeId: string; openDecisionId: string },
    observedAt = new Date(),
  ): Promise<M1FailedMoveRescueDecision> {
    const rescue = evaluateM1FailedMoveRescue(input);
    await this.evidence.markRescueObservation(decisionId, {
      openTradeId: linkage.openTradeId,
      openDecisionId: linkage.openDecisionId,
      observedAt,
      rescue,
    });
    return rescue;
  }

  private async shadowPairSideReliabilityFor(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    routeDecision: M1TacticalRouteDecision,
    evaluatedAt: Date,
  ): Promise<M1ScoutPairSideReliabilityDecision | null> {
    const earlyTransitionScoutPhase =
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_MICRO' ||
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_010' ||
      this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_TIERED';
    if (
      !earlyTransitionScoutPhase ||
      !routeDecision.eligible ||
      routeDecision.route !== 'M1_EARLY_TRANSITION'
    ) {
      return null;
    }

    const outcomes = await this.evidence.loadShadowPairSideOutcomes({
      userId,
      brokerConnectionId,
      route: 'M1_EARLY_TRANSITION',
      instrument: candidate.instrument,
      direction: candidate.direction,
      policyVersion: candidate.policyVersion,
      evaluatedAt,
    });
    if (this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_010') {
      return evaluateM1MeaningfulScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt,
        outcomes,
      });
    }
    if (this.rolloutPolicy.phase === 'PAPER_EARLY_TRANSITION_SCOUT_TIERED') {
      const meaningful = evaluateM1MeaningfulScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt,
        outcomes,
      });
      if (meaningful.samples >= M1_MEANINGFUL_SCOUT_MIN_SAMPLES) return meaningful;
      return evaluateM1ProvisionalScoutReliability({
        route: 'M1_EARLY_TRANSITION',
        evaluatedAt,
        outcomes,
      });
    }
    return evaluateM1ShadowPairSideReliability({
      route: 'M1_EARLY_TRANSITION',
      evaluatedAt,
      outcomes,
    });
  }

  private async reliabilityFor(
    userId: string,
    brokerConnectionId: string,
    candidate: M1TacticalCandidate,
    routeDecision: M1TacticalRouteDecision,
    evaluatedAt: Date,
  ) {
    if (!routeDecision.eligible || routeDecision.route === 'ABSTAIN') return null;
    const route = routeDecision.route as M1ReliabilityRoute;
    const evidenceRows = await this.evidence.loadRoutePairSideEvidence({
      userId,
      brokerConnectionId,
      route,
      instrument: candidate.instrument,
      direction: candidate.direction,
      currentPolicyVersion: candidate.policyVersion,
      compatiblePolicyVersions: [candidate.policyVersion],
      evaluatedAt,
    });
    return evaluateM1RoutePairSideReliability({
      route,
      instrument: candidate.instrument,
      direction: candidate.direction,
      currentPolicyVersion: candidate.policyVersion,
      evaluatedAt,
      evidenceRows,
    });
  }

  private enabled(): boolean {
    return (
      this.config.get<boolean>('vpsForexScanner.enabled', false) === true &&
      Boolean(this.userId()) &&
      Boolean(this.connectionId())
    );
  }

  private userId(): string {
    return this.config.get<string>('vpsForexScanner.userId', '').trim();
  }

  private connectionId(): string {
    return this.config.get<string>('vpsForexScanner.brokerConnectionId', '').trim();
  }
}
