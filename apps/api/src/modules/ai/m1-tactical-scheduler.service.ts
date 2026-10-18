import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiSignalService } from './ai-signal.service';
import { MacroEventRiskService } from './macro-event-risk.service';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import { M1TacticalMarketDataService } from './m1-tactical-market-data.service';
import {
  buildM1TacticalCandidates,
  M1_TACTICAL_POLICY_V1,
  type M1TacticalCandidate,
} from './m1-tactical-candidate';
import { buildM1TacticalFeatures } from './m1-tactical-features';
import { classifyM1TacticalRoute, type M1TacticalRouteDecision } from './m1-tactical-route';
import { evaluateM1TacticalGovernance } from './m1-tactical-governance';
import {
  evaluateM1RoutePairSideReliability,
  type M1ReliabilityRoute,
} from './m1-tactical-reliability';
import { isFxWeeklySessionOpen } from '../market-data/utils/fx-weekly-session';

export type M1TacticalExecutionPhase = 'SHADOW' | 'PAPER_CONTINUATION' | 'PAPER_ALL_ROUTES';

export interface M1TacticalRolloutPolicy {
  version: string;
  phase: M1TacticalExecutionPhase;
  cadenceMs: number;
  instruments: readonly string[];
}

export const M1_TACTICAL_ROLLOUT_POLICY_TOKEN = 'M1_TACTICAL_ROLLOUT_POLICY';
export const M1_TACTICAL_ROLLOUT_POLICY_V1: Readonly<M1TacticalRolloutPolicy> = Object.freeze({
  version: 'm1-tactical-rollout-v1',
  phase: 'SHADOW',
  cadenceMs: 15_000,
  instruments: Object.freeze(['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF']),
});

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

  constructor(
    private readonly config: ConfigService,
    private readonly marketData: M1TacticalMarketDataService,
    private readonly macroEventRisk: MacroEventRiskService,
    private readonly evidence: M1TacticalEvidenceService,
    private readonly aiSignalService: AiSignalService,
    @Optional()
    @Inject(M1_TACTICAL_ROLLOUT_POLICY_TOKEN)
    rolloutPolicy?: M1TacticalRolloutPolicy,
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
      );
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
    const governance = evaluateM1TacticalGovernance({
      candidate,
      routeDecision,
      features,
      eventRisk,
      evaluatedAt: decisionTime,
      executionSpreadEvidence: spreadEvidence,
      reliability,
    });

    const shadowOnly = this.rolloutPolicy.phase === 'SHADOW';
    const blockers = unique([...governance.blockers, ...(shadowOnly ? ['M1_PHASE_SHADOW'] : [])]);

    await this.evidence.recordDecision({
      userId,
      brokerConnectionId,
      instrument: candidate.instrument,
      direction: candidate.direction,
      route: routeDecision.route,
      barTime: candidate.latestM1OpenTime,
      evaluatedAt: decisionTime,
      policyVersion: candidate.policyVersion,
      executionAuthority: shadowOnly ? 'NONE' : governance.executionAuthority,
      candidate: { ...candidate },
      governance: {
        ...governance,
        routeDecision: { ...routeDecision },
        reliability: reliability ? { ...reliability } : null,
        rolloutPolicyVersion: this.rolloutPolicy.version,
        rolloutPhase: this.rolloutPolicy.phase,
      },
      blockers,
    });

    // Task 6 is intentionally observational. Task 7 is the first task allowed
    // to call AiSignalService, and even then only through PAPER governance.
    void this.aiSignalService;
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
