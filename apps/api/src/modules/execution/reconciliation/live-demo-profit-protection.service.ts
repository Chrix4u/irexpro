import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditService } from '../../audit/audit.service';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { CTRADER_FAMILY_BROKER_IDS } from '../../broker/registry/broker-catalog';
import { ExecutionService } from '../execution.service';
import { TradeCloseReason } from '../entities/trade.entity';
import { evaluatePaperProfitLock } from '../../broker/adapters/paper-broker.adapter';
import { evaluateProtectedRunnerShadow } from './protected-runner-shadow';
import { evaluateProfitLockPatienceShadow } from './profit-lock-patience-shadow';
import { evaluateZaiP1ReversalDemoPreflight } from './zai-p1-reversal-demo-canary';

const LIVE_DEMO_PROFIT_PROTECTION_INTERVAL_MS = 5_000;
// Maximum ordinary adverse-thesis grace from actual position open. A new
// interval never starts at each scan/restart; a hard broker SL is never moved.
export const CONTINUATION_RECOVERY_GRACE_MINUTES = 4.5;

export interface LiveDemoM1AdverseEvidence {
  completedBars: number;
  adverseBars: number;
  alignedLatestBodyPressure: number;
  alignedMomentum3: number;
  latestAgeSeconds: number;
  /** Independently observed cTrader quotes, never inferred from trendbar tick volume. */
  liveQuoteBars?: number;
  /** Count of truly consecutive latest completed, independently quoted M1 bars. */
  consecutiveLiveQuoteBars?: number;
  latestLiveSpreadPrice?: number | null;
}

export interface LiveDemoAdverseProtectionDecision {
  shouldClose: boolean;
  reason:
    | 'TOO_EARLY'
    | 'INVALID_RISK'
    | 'PROFIT_PROTECTION_OWNS_TRADE'
    | 'NOT_ADVERSE'
    | 'M1_EVIDENCE_UNAVAILABLE'
    | 'RECOVERY_FORMING'
    | 'ADVERSE_THESIS_FAILED'
    | 'EMERGENCY_ADVERSE_CUT'
    | 'HOLD';
  currentR: number | null;
}

/**
 * A narrowly scoped hold for EXISTING trend-continuation positions, never a
 * new entry permission. Does not suppress broker stop, emergency adverse cut,
 * confirmed opposite reversal, profit protection, or manual exit.
 * Fail-closed on missing/stale same-side context and broker quote evidence.
 */
export function evaluateContinuationRecoveryGrace(input: {
  tradeDirection: 'BUY' | 'SELL';
  strategyRoute: string | null;
  elapsedMinutes: number;
  currentR: number | null;
  adverseReason: LiveDemoAdverseProtectionDecision['reason'];
  m1Evidence: LiveDemoM1AdverseEvidence | null;
  m5Aligned: number | null;
  m15Aligned: number | null;
  alignmentObservedAt: Date | null;
  observedAt: Date;
  authoritativeStop: number | null;
  brokerStop: number | null;
  currentPrice: number | null;
}): boolean {
  if (
    input.strategyRoute !== 'TREND_CONTINUATION' ||
    input.adverseReason !== 'ADVERSE_THESIS_FAILED' ||
    !Number.isFinite(input.elapsedMinutes) ||
    input.elapsedMinutes < 1 ||
    input.elapsedMinutes >= CONTINUATION_RECOVERY_GRACE_MINUTES ||
    input.currentR === null ||
    !Number.isFinite(input.currentR) ||
    input.currentR <= -0.65 ||
    input.currentR > -0.45 ||
    input.authoritativeStop === null ||
    input.authoritativeStop <= 0 ||
    input.brokerStop === null ||
    input.brokerStop <= 0 ||
    // A configured DB stop is not sufficient: the broker must actually show
    // the same protective stop for the currently open position.
    Math.abs(input.brokerStop - input.authoritativeStop) >
      Math.max(0.00001, input.authoritativeStop * 1e-7) ||
    input.currentPrice === null ||
    input.currentPrice <= 0 ||
    (input.tradeDirection === 'BUY'
      ? input.currentPrice <= input.authoritativeStop
      : input.currentPrice >= input.authoritativeStop)
  ) {
    return false;
  }
  const m1 = input.m1Evidence;
  if (
    !m1 ||
    m1.completedBars < 2 ||
    (m1.consecutiveLiveQuoteBars ?? 0) < 2 ||
    m1.latestAgeSeconds < 0 ||
    m1.latestAgeSeconds > 90 ||
    !Number.isFinite(m1.alignedLatestBodyPressure) ||
    !Number.isFinite(m1.alignedMomentum3)
  ) {
    return false;
  }
  if (
    input.m5Aligned === null ||
    input.m15Aligned === null ||
    !Number.isFinite(input.m5Aligned) ||
    !Number.isFinite(input.m15Aligned) ||
    input.m5Aligned <= 0 ||
    input.m15Aligned <= 0 ||
    !input.alignmentObservedAt
  ) {
    return false;
  }
  const asOfAge = (input.observedAt.getTime() - input.alignmentObservedAt.getTime()) / 1000;
  return Number.isFinite(asOfAge) && asOfAge >= 0 && asOfAge <= 150;
}

export interface LiveDemoTrainedExpertThesis {
  direction: 'BUY' | 'SELL' | null;
  allBrokerNative: boolean;
  longVotes: number;
  shortVotes: number;
  ensembleConfidence: number | null;
  freshnessSeconds: number | null;
}

export interface LiveDemoAuthoritativeThesis {
  direction: 'BUY' | 'SELL';
  evaluatedAt: Date;
  executionAuthority: string;
  blockers: string[];
  planBStrategyRoute: 'TREND_CONTINUATION' | 'CONFIRMED_REVERSAL' | 'EARLY_TRANSITION' | null;
  authorityExecutable: boolean;
  trainedExpert: LiveDemoTrainedExpertThesis | null;
}

export interface LiveDemoThesisProtectionDecision {
  shouldClose: boolean;
  reason:
    | 'INVALID_RISK'
    | 'NO_THESIS'
    | 'THESIS_STALE'
    | 'SAME_DIRECTION'
    | 'OPPOSITE_EXPERT_PROFIT_HARVEST'
    | 'OPPOSITE_NOT_CONFIRMED_REVERSAL'
    | 'CONFIRMED_REVERSAL_NEAR_BREAKEVEN'
    | 'CONFIRMED_REVERSAL_HARD_CUT'
    | 'CONFIRMED_REVERSAL_RECOVERY_WINDOW'
    | 'CONFIRMED_REVERSAL_GRACE_EXPIRED';
  currentR: number | null;
}

export function evaluateLiveDemoThesisProtection(input: {
  tradeDirection: 'BUY' | 'SELL';
  currentPnl: number;
  initialRiskPnl: number;
  observedAt: Date;
  latestThesis: LiveDemoAuthoritativeThesis | null;
}): LiveDemoThesisProtectionDecision {
  const hold = (
    reason: LiveDemoThesisProtectionDecision['reason'],
    currentR: number | null,
  ): LiveDemoThesisProtectionDecision => ({ shouldClose: false, reason, currentR });
  if (!Number.isFinite(input.initialRiskPnl) || input.initialRiskPnl <= 0) {
    return hold('INVALID_RISK', null);
  }
  const currentR = input.currentPnl / input.initialRiskPnl;
  const thesis = input.latestThesis;
  if (!thesis) return hold('NO_THESIS', currentR);

  const thesisAgeSeconds = (input.observedAt.getTime() - thesis.evaluatedAt.getTime()) / 1000;
  if (!Number.isFinite(thesisAgeSeconds) || thesisAgeSeconds < 0 || thesisAgeSeconds > 150) {
    return hold('THESIS_STALE', currentR);
  }
  if (thesis.direction === input.tradeDirection) return hold('SAME_DIRECTION', currentR);

  const expert = thesis.trainedExpert;
  const opposingExpertVotes =
    input.tradeDirection === 'BUY' ? (expert?.shortVotes ?? 0) : (expert?.longVotes ?? 0);
  const sameDirectionExpertVotes =
    input.tradeDirection === 'BUY' ? (expert?.longVotes ?? 0) : (expert?.shortVotes ?? 0);
  const unanimousFreshExpertOpposition =
    expert?.direction === thesis.direction &&
    expert.allBrokerNative === true &&
    opposingExpertVotes >= 3 &&
    sameDirectionExpertVotes === 0 &&
    expert.ensembleConfidence !== null &&
    expert.ensembleConfidence >= 0.7 &&
    expert.freshnessSeconds !== null &&
    expert.freshnessSeconds >= 0 &&
    expert.freshnessSeconds <= 120;

  if (currentR >= 0.15 && unanimousFreshExpertOpposition) {
    return { shouldClose: true, reason: 'OPPOSITE_EXPERT_PROFIT_HARVEST', currentR };
  }

  const confirmedReversal =
    thesis.executionAuthority === 'BROKER_NATIVE' &&
    thesis.blockers.length === 0 &&
    thesis.authorityExecutable === true &&
    thesis.planBStrategyRoute === 'CONFIRMED_REVERSAL';
  if (!confirmedReversal) return hold('OPPOSITE_NOT_CONFIRMED_REVERSAL', currentR);

  if (currentR >= -0.12) {
    return { shouldClose: true, reason: 'CONFIRMED_REVERSAL_NEAR_BREAKEVEN', currentR };
  }
  if (currentR <= -0.35) {
    return { shouldClose: true, reason: 'CONFIRMED_REVERSAL_HARD_CUT', currentR };
  }
  if (thesisAgeSeconds >= 45) {
    return { shouldClose: true, reason: 'CONFIRMED_REVERSAL_GRACE_EXPIRED', currentR };
  }
  return hold('CONFIRMED_REVERSAL_RECOVERY_WINDOW', currentR);
}

/**
 * DEMO-only adverse-thesis guard.
 *
 * Broker SL remains the hard backstop. This guard only acts after at least one
 * completed broker-native M1 candle confirms that a materially losing trade is
 * still moving against its entry thesis. A trade that already armed the
 * profit-lock is owned by profit protection instead, preventing competing exit
 * authorities.
 */
export function evaluateLiveDemoAdverseProtection(input: {
  elapsedMinutes: number;
  currentPnl: number;
  initialRiskPnl: number;
  maxFavorablePnl: number;
  profitLockArmed: boolean;
  m1Evidence: LiveDemoM1AdverseEvidence | null;
}): LiveDemoAdverseProtectionDecision {
  const hold = (
    reason: LiveDemoAdverseProtectionDecision['reason'],
    currentR: number | null,
  ): LiveDemoAdverseProtectionDecision => ({ shouldClose: false, reason, currentR });
  if (!Number.isFinite(input.initialRiskPnl) || input.initialRiskPnl <= 0) {
    return hold('INVALID_RISK', null);
  }
  const currentR = input.currentPnl / input.initialRiskPnl;
  if (!Number.isFinite(input.elapsedMinutes) || input.elapsedMinutes < 1) {
    return hold('TOO_EARLY', currentR);
  }
  if (input.profitLockArmed) return hold('PROFIT_PROTECTION_OWNS_TRADE', currentR);
  if (currentR >= 0) return hold('NOT_ADVERSE', currentR);

  const evidence = input.m1Evidence;
  if (
    !evidence ||
    evidence.completedBars < 1 ||
    evidence.latestAgeSeconds < 0 ||
    evidence.latestAgeSeconds > 90
  ) {
    return hold('M1_EVIDENCE_UNAVAILABLE', currentR);
  }

  if (evidence.alignedLatestBodyPressure > 0.2 && evidence.alignedMomentum3 >= 0) {
    return hold('RECOVERY_FORMING', currentR);
  }

  const favorableR = Math.max(0, input.maxFavorablePnl) / input.initialRiskPnl;
  const latestStillOpposing = evidence.alignedLatestBodyPressure <= -0.35;
  const persistentOpposition =
    evidence.completedBars >= 2 &&
    evidence.adverseBars >= Math.min(2, evidence.completedBars) &&
    evidence.alignedMomentum3 <= -0.15;

  if (currentR <= -0.65 && favorableR < 0.15 && latestStillOpposing) {
    return { shouldClose: true, reason: 'EMERGENCY_ADVERSE_CUT', currentR };
  }
  if (currentR <= -0.45 && favorableR < 0.15 && latestStillOpposing && persistentOpposition) {
    return { shouldClose: true, reason: 'ADVERSE_THESIS_FAILED', currentR };
  }
  return hold('HOLD', currentR);
}

/**
 * Prospective pre-exit trend recheck run in SHADOW mode as-of the moment
 * an existing DEMO profit lock asks to close. A proposed HOLD is research
 * evidence only; it cannot delay, cancel or replace the protective close.
 */
export interface LiveDemoProfitLockTrendRecheckDecision {
  wouldHoldIfEnabled: boolean;
  reason:
    | 'NO_THESIS'
    | 'THESIS_STALE'
    | 'THESIS_NOT_EXECUTABLE'
    | 'THESIS_OPPOSES_TRADE'
    | 'EXPERT_NOT_ALIGNED'
    | 'M1_LIVE_EVIDENCE_MISSING'
    | 'M1_MOMENTUM_NOT_SUPPORTIVE'
    | 'CONTINUATION_CANDIDATE';
  thesisAgeSeconds: number | null;
}

export function evaluateLiveDemoProfitLockTrendRecheck(input: {
  tradeDirection: 'BUY' | 'SELL';
  observedAt: Date;
  latestThesis: LiveDemoAuthoritativeThesis | null;
  m1Evidence: LiveDemoM1AdverseEvidence | null;
}): LiveDemoProfitLockTrendRecheckDecision {
  const reject = (
    reason: LiveDemoProfitLockTrendRecheckDecision['reason'],
    thesisAgeSeconds: number | null,
  ): LiveDemoProfitLockTrendRecheckDecision => ({
    wouldHoldIfEnabled: false,
    reason,
    thesisAgeSeconds,
  });
  const thesis = input.latestThesis;
  if (!thesis) return reject('NO_THESIS', null);

  const thesisAgeSeconds = (input.observedAt.getTime() - thesis.evaluatedAt.getTime()) / 1_000;
  if (!Number.isFinite(thesisAgeSeconds) || thesisAgeSeconds < 0 || thesisAgeSeconds > 90) {
    return reject('THESIS_STALE', thesisAgeSeconds);
  }
  if (
    thesis.executionAuthority !== 'BROKER_NATIVE' ||
    !thesis.authorityExecutable ||
    thesis.blockers.length > 0
  ) {
    return reject('THESIS_NOT_EXECUTABLE', thesisAgeSeconds);
  }
  if (thesis.direction !== input.tradeDirection) {
    return reject('THESIS_OPPOSES_TRADE', thesisAgeSeconds);
  }

  const expert = thesis.trainedExpert;
  const supportingVotes =
    input.tradeDirection === 'BUY' ? (expert?.longVotes ?? 0) : (expert?.shortVotes ?? 0);
  const opposingVotes =
    input.tradeDirection === 'BUY' ? (expert?.shortVotes ?? 0) : (expert?.longVotes ?? 0);
  if (
    !expert ||
    !expert.allBrokerNative ||
    expert.direction !== input.tradeDirection ||
    supportingVotes < 2 ||
    opposingVotes > 0 ||
    expert.ensembleConfidence === null ||
    expert.ensembleConfidence < 0.7 ||
    expert.freshnessSeconds === null ||
    expert.freshnessSeconds < 0 ||
    expert.freshnessSeconds > 60
  ) {
    return reject('EXPERT_NOT_ALIGNED', thesisAgeSeconds);
  }

  const m1 = input.m1Evidence;
  if (
    !m1 ||
    m1.completedBars < 2 ||
    (m1.liveQuoteBars ?? 0) < 2 ||
    m1.latestAgeSeconds < 0 ||
    m1.latestAgeSeconds > 90
  ) {
    return reject('M1_LIVE_EVIDENCE_MISSING', thesisAgeSeconds);
  }
  if (m1.alignedLatestBodyPressure < 0.15 || m1.alignedMomentum3 < 0.1 || m1.adverseBars > 1) {
    return reject('M1_MOMENTUM_NOT_SUPPORTIVE', thesisAgeSeconds);
  }
  return { wouldHoldIfEnabled: true, reason: 'CONTINUATION_CANDIDATE', thesisAgeSeconds };
}

interface OpenAiTradeRow {
  trade_id: string;
  user_id: string;
  broker_connection_id: string;
  external_order_id: string | null;
  external_position_id: string | null;
  instrument: string;
  direction: 'BUY' | 'SELL';
  max_favorable_pnl: string | number | null;
  max_adverse_pnl: string | number | null;
  profit_giveback: string | number | null;
  path_observation_count: string | number | null;
  path_peak_observed_at: Date | string | null;
  initial_risk_pnl: string | number | null;
  stop_loss: string | number | null;
  lot_size: string | number | null;
  account_currency: string | null;
  opened_at: Date | string | null;
  is_m1_strategy: boolean;
  strategy_route: string | null;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number): string {
  return value.toFixed(8);
}

/**
 * Fast post-entry manager for promoted cTrader DEMO positions.
 *
 * It intentionally has NO authority over real-money LIVE accounts. Broker SL/TP
 * remain the hard backstop; this layer restores the already-validated PAPER
 * MFE/MAE/giveback profit-lock policy to the promoted DEMO execution path.
 */
@Injectable()
export class LiveDemoProfitProtectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveDemoProfitProtectionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly brokerService: BrokerService,
    private readonly executionService: ExecutionService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const initial = setTimeout(() => void this.runOnce(), 2_000);
    initial.unref?.();
    this.timer = setInterval(() => void this.runOnce(), LIVE_DEMO_PROFIT_PROTECTION_INTERVAL_MS);
    this.timer.unref?.();
    this.logger.log(
      `cTrader DEMO profit protection enabled cadence=${LIVE_DEMO_PROFIT_PROTECTION_INTERVAL_MS / 1000}s authority=PROFIT_PROTECTION LIVE=false`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(observedAt = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.loadOpenAiTrades();
      const groups = new Map<string, OpenAiTradeRow[]>();
      for (const row of rows) {
        const key = `${row.user_id}:${row.broker_connection_id}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }

      for (const trades of groups.values()) {
        const first = trades[0];
        if (!first) continue;
        try {
          const snapshot = await this.brokerService.getOpenPositionsForConnection(
            first.broker_connection_id,
            first.user_id,
          );
          if (
            !CTRADER_FAMILY_BROKER_IDS.includes(snapshot.connection.brokerId) ||
            String(snapshot.connection.accountType).toUpperCase() !== 'DEMO'
          ) {
            continue;
          }
          const positions = new Map(
            snapshot.positions.map((position) => [position.externalOrderId, position] as const),
          );

          for (const trade of trades) {
            const providerPositionId = trade.external_position_id ?? trade.external_order_id;
            if (!providerPositionId) continue;
            const position = positions.get(providerPositionId);
            if (!position) continue;
            const currentPnl = finite(position.unrealisedPnl);
            // Broker-native price-path evidence has value even if the capital
            // allocation's R-at-stop proof is absent. Risk-less observations
            // must never activate an automated exit.
            if (currentPnl === null) continue;

            const previousPeak = finite(trade.max_favorable_pnl) ?? 0;
            const previousAdverse = finite(trade.max_adverse_pnl) ?? 0;
            const maxFavorablePnl = Math.max(0, previousPeak, currentPnl);
            const maxAdversePnl = Math.min(0, previousAdverse, currentPnl);
            const profitGiveback = Math.max(0, maxFavorablePnl - currentPnl);
            const observationCount = Math.max(0, Number(trade.path_observation_count) || 0) + 1;
            const isNewPeak = currentPnl > previousPeak;
            const peakObservedAt = isNewPeak
              ? observedAt
              : trade.path_peak_observed_at
                ? new Date(trade.path_peak_observed_at)
                : observedAt;

            await this.persistTelemetry({
              tradeId: trade.trade_id,
              maxFavorablePnl,
              maxAdversePnl,
              profitGiveback,
              observationCount,
              peakObservedAt,
              observedAt,
            });

            // Pepperstone and other cTrader-family DEMO accounts receive
            // read-only peak/adverse/give-back telemetry. Existing cTrader
            // exit authority is unchanged until broker-specific profit-lock
            // outcomes have been validated. LIVE remains excluded above.
            if (snapshot.connection.brokerId !== 'ctrader') continue;
            const initialRisk = finite(trade.initial_risk_pnl);
            if (initialRisk === null || initialRisk <= 0) continue;

            const authoritativeStop = finite(trade.stop_loss);
            const currentPrice = finite(position.currentPrice);
            const stopBreached =
              authoritativeStop !== null &&
              authoritativeStop > 0 &&
              currentPrice !== null &&
              ((trade.direction === 'BUY' && currentPrice <= authoritativeStop) ||
                (trade.direction === 'SELL' && currentPrice >= authoritativeStop));
            if (stopBreached) {
              this.logger.warn(
                `cTrader DEMO STOP_LOSS_CATCHUP trade=${trade.trade_id} ${trade.instrument} ${trade.direction} ` +
                  `current=${currentPrice} authorityStop=${authoritativeStop}`,
              );
              await this.executionService.closeTrade(
                trade.trade_id,
                trade.user_id,
                TradeCloseReason.STOP_LOSS_HIT,
              );
              continue;
            }

            const strategyRoute =
              trade.strategy_route === 'TREND_CONTINUATION' ||
              trade.strategy_route === 'CONFIRMED_REVERSAL' ||
              trade.strategy_route === 'EARLY_TRANSITION'
                ? trade.strategy_route
                : null;
            const decision = evaluatePaperProfitLock({
              maxFavorablePnl: money(maxFavorablePnl),
              currentPnl: money(currentPnl),
              initialRiskPnl: money(initialRisk),
              isM1Strategy: trade.is_m1_strategy,
              strategyRoute,
            });
            if (decision.shouldClose) {
              this.logger.warn(
                `cTrader DEMO PROFIT_PROTECTION trade=${trade.trade_id} ${trade.instrument} ${trade.direction} ` +
                  `peak=${money(maxFavorablePnl)} current=${money(currentPnl)} risk=${money(initialRisk)} ` +
                  `giveback=${money(profitGiveback)} floor=${decision.protectedFloorPnl} retain=${decision.retentionFraction}`,
              );
              // The real profit lock still closes immediately. Reconstruct
              // a causal as-of-decision trend check AFTER dispatch for
              // prospective research; a shadow HOLD never creates exposure.
              await this.executionService.closeTrade(
                trade.trade_id,
                trade.user_id,
                TradeCloseReason.PROFIT_PROTECTION,
              );
              await this.recordProfitLockTrendRecheck(trade, observedAt, currentPnl, initialRisk, {
                entryPrice: position.openPrice,
                currentPrice: position.currentPrice,
                takeProfitPrice: position.takeProfit,
              });
              continue;
            }

            const latestThesis = await this.loadLatestAiThesis(trade, observedAt);
            const thesisDecision = evaluateLiveDemoThesisProtection({
              tradeDirection: trade.direction,
              currentPnl,
              initialRiskPnl: initialRisk,
              observedAt,
              latestThesis,
            });
            if (thesisDecision.shouldClose) {
              this.logger.warn(
                `cTrader DEMO AI_CLOSE_SIGNAL trade=${trade.trade_id} ${trade.instrument} ${trade.direction} ` +
                  `reason=${thesisDecision.reason} currentR=${thesisDecision.currentR?.toFixed(3) ?? 'n/a'} ` +
                  `peak=${money(maxFavorablePnl)} current=${money(currentPnl)} risk=${money(initialRisk)}`,
              );
              await this.executionService.closeTrade(
                trade.trade_id,
                trade.user_id,
                TradeCloseReason.AI_CLOSE_SIGNAL,
                { source: 'BROKER_THESIS_PROTECTION', reasonCode: thesisDecision.reason },
              );
              continue;
            }

            if (currentPnl >= 0 || !trade.opened_at) continue;
            const openedAt = new Date(trade.opened_at);
            if (!Number.isFinite(openedAt.getTime())) continue;
            const m1Evidence = await this.loadCausalM1Evidence(trade, observedAt);
            const adverseDecision = evaluateLiveDemoAdverseProtection({
              elapsedMinutes: Math.max(0, (observedAt.getTime() - openedAt.getTime()) / 60_000),
              currentPnl,
              initialRiskPnl: initialRisk,
              maxFavorablePnl,
              profitLockArmed: decision.armed,
              m1Evidence,
            });
            if (!adverseDecision.shouldClose) continue;

            // Only ordinary, moderate adverse-thesis continuation cuts can
            // receive a bounded re-evaluation. All emergency, broker stop,
            // qualified opposite-reversal and protective exits already ran.
            // A failed/slow research-context read must NOT prevent closing.
            if (
              adverseDecision.reason === 'ADVERSE_THESIS_FAILED' &&
              trade.is_m1_strategy &&
              strategyRoute === 'TREND_CONTINUATION'
            ) {
              let alignedContext: {
                m5Aligned: number | null;
                m15Aligned: number | null;
                observedAt: Date;
              } | null = null;
              try {
                alignedContext = await this.loadPositionSideAlignmentWithinDeadline(
                  trade,
                  observedAt,
                );
              } catch {
                this.logger.warn(
                  'cTrader adverse grace context unavailable; normal close remains eligible',
                );
              }
              const elapsedMinutes = (observedAt.getTime() - openedAt.getTime()) / 60_000;
              if (
                evaluateContinuationRecoveryGrace({
                  tradeDirection: trade.direction,
                  strategyRoute,
                  elapsedMinutes,
                  currentR: adverseDecision.currentR,
                  adverseReason: adverseDecision.reason,
                  m1Evidence,
                  m5Aligned: alignedContext?.m5Aligned ?? null,
                  m15Aligned: alignedContext?.m15Aligned ?? null,
                  alignmentObservedAt: alignedContext?.observedAt ?? null,
                  observedAt,
                  authoritativeStop,
                  brokerStop: finite(position.stopLoss),
                  currentPrice,
                })
              ) {
                // Avoid logging the same trade twelve times per minute.
                if (Math.floor(observedAt.getTime() / 5_000) % 12 === 0) {
                  this.logger.log(
                    `cTrader adverse recovery grace trade=${trade.trade_id} ${trade.instrument} ${trade.direction} ` +
                      `elapsedMin=${elapsedMinutes.toFixed(2)} currentR=${adverseDecision.currentR?.toFixed(3) ?? 'n/a'} ` +
                      `M5M15=ALIGNED stop=UNCHANGED hardExit=ACTIVE`,
                  );
                }
                continue;
              }
            }

            this.logger.warn(
              `cTrader DEMO AI_CLOSE_SIGNAL trade=${trade.trade_id} ${trade.instrument} ${trade.direction} ` +
                `reason=${adverseDecision.reason} currentR=${adverseDecision.currentR?.toFixed(3) ?? 'n/a'} ` +
                `peak=${money(maxFavorablePnl)} current=${money(currentPnl)} risk=${money(initialRisk)}`,
            );
            await this.executionService.closeTrade(
              trade.trade_id,
              trade.user_id,
              TradeCloseReason.AI_CLOSE_SIGNAL,
              { source: 'BROKER_ADVERSE_PROTECTION', reasonCode: adverseDecision.reason },
            );
          }
        } catch (error) {
          this.logger.warn(
            `cTrader DEMO profit-protection cycle deferred connection=${first.broker_connection_id}: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Shadow-only audit, intentionally performed AFTER the protective close
   * request so database reads cannot delay the broker close. Both input
   * readers are constrained to evidence available at observedAt, never the
   * subsequent movement used to evaluate their hypothetical HOLD decisions.
   */
  private async recordProfitLockTrendRecheck(
    trade: OpenAiTradeRow,
    observedAt: Date,
    currentPnl: number,
    initialRiskPnl: number,
    positionPrices: {
      entryPrice: string | number | null;
      currentPrice: string | number | null;
      takeProfitPrice: string | number | null;
    },
  ): Promise<void> {
    if (!this.auditService) return;
    try {
      const [latestThesis, m1Evidence, patienceSignal] = await Promise.all([
        this.loadLatestAiThesis(trade, observedAt),
        this.loadCausalM1Evidence(trade, observedAt),
        this.loadProfitLockPatienceSignal(trade, observedAt),
      ]);
      const recheck = evaluateLiveDemoProfitLockTrendRecheck({
        tradeDirection: trade.direction,
        observedAt,
        latestThesis,
        m1Evidence,
      });
      // This research asks whether a protected, short in-position wait was
      // reasonable; it never grants a new order or suppresses the real close.
      const patience = evaluateProfitLockPatienceShadow({
        direction: trade.direction,
        observedAt,
        currentGrossPnl: currentPnl,
        initialRiskPnl,
        maxFavorablePnl: Math.max(currentPnl, finite(trade.max_favorable_pnl) ?? 0),
        latestSameSideM1ContinuationAt: patienceSignal.sameSideContinuationAt,
        oppositeExecutableReversal: patienceSignal.oppositeExecutableReversal,
        m1Evidence: m1Evidence
          ? {
              completedBars: m1Evidence.completedBars,
              liveQuoteBars: m1Evidence.liveQuoteBars ?? 0,
              latestAgeSeconds: m1Evidence.latestAgeSeconds,
              adverseBars: m1Evidence.adverseBars,
              alignedLatestBodyPressure: m1Evidence.alignedLatestBodyPressure,
              alignedMomentum3: m1Evidence.alignedMomentum3,
            }
          : null,
      });
      // Historical fees are scoped by account, symbol and currency, and every
      // sample must have closed BEFORE the observed decision time.
      const fees =
        recheck.wouldHoldIfEnabled || patience.wouldConsiderBrokerProtectedGrace
          ? await this.loadCausalRunnerCostEstimate(trade, observedAt)
          : null;
      const runner = evaluateProtectedRunnerShadow({
        trendWouldHold: recheck.wouldHoldIfEnabled,
        instrument: trade.instrument,
        direction: trade.direction,
        grossUnrealisedPnl: currentPnl,
        initialRiskPnl,
        estimatedBrokerCosts: fees?.estimatedCost ?? null,
        feeSampleCount: fees?.sampleCount ?? 0,
        entryPrice: positionPrices.entryPrice == null ? null : finite(positionPrices.entryPrice),
        currentPrice:
          positionPrices.currentPrice == null ? null : finite(positionPrices.currentPrice),
        originalStopPrice: trade.stop_loss == null ? null : finite(trade.stop_loss),
        takeProfitPrice:
          positionPrices.takeProfitPrice == null ? null : finite(positionPrices.takeProfitPrice),
        latestLiveSpreadPrice: m1Evidence?.latestLiveSpreadPrice ?? null,
      });
      const patienceRunner = evaluateProtectedRunnerShadow({
        trendWouldHold: patience.wouldConsiderBrokerProtectedGrace,
        instrument: trade.instrument,
        direction: trade.direction,
        grossUnrealisedPnl: currentPnl,
        initialRiskPnl,
        estimatedBrokerCosts: fees?.estimatedCost ?? null,
        feeSampleCount: fees?.sampleCount ?? 0,
        entryPrice: positionPrices.entryPrice == null ? null : finite(positionPrices.entryPrice),
        currentPrice:
          positionPrices.currentPrice == null ? null : finite(positionPrices.currentPrice),
        originalStopPrice: trade.stop_loss == null ? null : finite(trade.stop_loss),
        takeProfitPrice:
          positionPrices.takeProfitPrice == null ? null : finite(positionPrices.takeProfitPrice),
        latestLiveSpreadPrice: m1Evidence?.latestLiveSpreadPrice ?? null,
      });
      const zaiP1Canary = evaluateZaiP1ReversalDemoPreflight({
        // The caller has already verified this exact adapter connection is
        // cTrader DEMO; no new provider authorization is inferred here.
        brokerId: 'ctrader',
        accountType: 'DEMO',
        strategyRoute: trade.strategy_route,
        confirmedFreshTrend: recheck.wouldHoldIfEnabled,
        direction: trade.direction,
        initialLot: trade.lot_size,
        initialRiskPnl,
        currentGrossPnl: currentPnl,
        estimateRoundTripFee: fees?.estimatedCost ?? null,
        historicalFeeSamples: fees?.sampleCount ?? 0,
        entryPrice: positionPrices.entryPrice == null ? null : finite(positionPrices.entryPrice),
        currentPrice:
          positionPrices.currentPrice == null ? null : finite(positionPrices.currentPrice),
        originalStopPrice: trade.stop_loss == null ? null : finite(trade.stop_loss),
        originalTakeProfitPrice:
          positionPrices.takeProfitPrice == null ? null : finite(positionPrices.takeProfitPrice),
      });
      await this.auditService.log({
        actorUserId: trade.user_id,
        action: AuditAction.DEMO_PROFIT_LOCK_TREND_RECHECK,
        resourceType: 'Trade',
        resourceId: trade.trade_id,
        metadata: {
          mode: 'SHADOW_ONLY',
          observedAt: observedAt.toISOString(),
          recommendation: recheck.wouldHoldIfEnabled ? 'HOLD_CANDIDATE' : 'CLOSE_CANDIDATE',
          reason: recheck.reason,
          thesisAgeSeconds: recheck.thesisAgeSeconds,
          currentR: currentPnl / initialRiskPnl,
          strategyRoute: trade.strategy_route,
          originalCloseReason: TradeCloseReason.PROFIT_PROTECTION,
          m1LiveQuoteBars: m1Evidence?.liveQuoteBars ?? 0,
          m1AlignedMomentum3: m1Evidence?.alignedMomentum3 ?? null,
          m1LatestAgeSeconds: m1Evidence?.latestAgeSeconds ?? null,
          runnerShadow: runner,
          protectedGraceShadow: patience,
          protectedGraceRunnerShadow: patienceRunner,
          protectedGraceOppositeExecutableReversal: patienceSignal.oppositeExecutableReversal,
          m1AlignedLatestBodyPressure: m1Evidence?.alignedLatestBodyPressure ?? null,
          m1AdverseBars: m1Evidence?.adverseBars ?? null,
          zaiP1Canary,
          runnerCostEvidence: fees ? 'RECENT_CLOSED_TRADES_BEFORE_DECISION' : 'INSUFFICIENT',
          noTradeAuthority: true,
        },
      });
    } catch (error) {
      // A research observation must never impede execution, even if its
      // historical read, adapter, audit repository or serialization fails.
      this.logger.warn(
        `cTrader DEMO shadow trend recheck unavailable trade=${trade.trade_id}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Research-only as-of M1 continuation observations for the held position.
   * A separate NEW entry may still be OOD, unprofitable or unadmitted.
   * This query cannot grant any broker authority.
   */
  private async loadProfitLockPatienceSignal(
    trade: OpenAiTradeRow,
    observedAt: Date,
  ): Promise<{ sameSideContinuationAt: Date | null; oppositeExecutableReversal: boolean }> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          MAX(evaluated_at) FILTER (
            WHERE direction = $4 AND route = 'M1_TREND_CONTINUATION'
          ) AS same_side_continuation_at,
          COALESCE(BOOL_OR(
            direction <> $4
            AND route = 'M1_CONFIRMED_REVERSAL'
            AND execution_authority = 'BROKER_NATIVE'
            AND blockers = '[]'::jsonb
            AND evaluated_at >= $5::timestamptz - interval '90 seconds'
          ), false) AS opposite_executable_reversal
        FROM trading.m1_tactical_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND instrument = $3
          AND evaluated_at <= $5::timestamptz
          AND evaluated_at >= $5::timestamptz - interval '180 seconds'
      `,
      [
        trade.user_id,
        trade.broker_connection_id,
        trade.instrument.toUpperCase(),
        trade.direction,
        observedAt.toISOString(),
      ],
    )) as Array<{
      same_side_continuation_at: Date | string | null;
      opposite_executable_reversal: boolean | string | null;
    }>;
    const row = rows[0];
    const time = row?.same_side_continuation_at ? new Date(row.same_side_continuation_at) : null;
    return {
      sameSideContinuationAt: time && Number.isFinite(time.getTime()) ? time : null,
      oppositeExecutableReversal:
        row?.opposite_executable_reversal === true || row?.opposite_executable_reversal === 'true',
    };
  }

  /**
   * Conservative p90 of positive historical commission/financing cost per
   * lot. A minimum of five past, same-account/symbol/currency samples is
   * required; no future closes can influence a proposed runner.
   */
  private async loadCausalRunnerCostEstimate(
    trade: OpenAiTradeRow,
    observedAt: Date,
  ): Promise<{ estimatedCost: number; sampleCount: number } | null> {
    const lotSize = trade.lot_size == null ? null : finite(trade.lot_size);
    if (!lotSize || lotSize <= 0 || !trade.account_currency) return null;
    const rows = (await this.dataSource.query(
      `
        SELECT COUNT(*)::int AS sample_count,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY fee_per_lot) AS p90_cost_per_lot
        FROM (
          SELECT (
            ABS(t.commission) + GREATEST(0, -COALESCE(t.swap, 0))
          ) / NULLIF(t.lot_size, 0) AS fee_per_lot
          FROM trading.trades t
          WHERE t.broker_connection_id = $1
            AND t.instrument = $2
            AND t.account_currency = $3
            AND t.status = 'CLOSED'
            AND t.closed_at < $4::timestamptz
            AND t.closed_at >= $4::timestamptz - interval '21 days'
            AND t.lot_size > 0
            AND t.commission IS NOT NULL
          ORDER BY t.closed_at DESC
          LIMIT 40
        ) past_fees
      `,
      [
        trade.broker_connection_id,
        trade.instrument.toUpperCase(),
        trade.account_currency,
        observedAt.toISOString(),
      ],
    )) as Array<{ sample_count: string | number; p90_cost_per_lot: string | number | null }>;
    const row = rows[0];
    const sampleCount = Number(row?.sample_count ?? 0);
    const costPerLot = row?.p90_cost_per_lot == null ? null : finite(row.p90_cost_per_lot);
    if (
      !Number.isInteger(sampleCount) ||
      sampleCount < 5 ||
      costPerLot === null ||
      costPerLot <= 0
    ) {
      return null;
    }
    return { estimatedCost: costPerLot * lotSize, sampleCount };
  }

  private async loadOpenAiTrades(): Promise<OpenAiTradeRow[]> {
    return (await this.dataSource.query(`
      SELECT
        t.id AS trade_id,
        t.user_id,
        t.broker_connection_id,
        t.external_order_id,
        t.external_position_id,
        t.instrument,
        t.direction,
        t.lot_size,
        t.account_currency,
        t.max_favorable_pnl,
        t.max_adverse_pnl,
        t.profit_giveback,
        t.path_observation_count,
        t.path_peak_observed_at,
        t.opened_at,
        COALESCE(
          NULLIF(ti.metadata->>'multimodel_plan_b_route', ''),
          CASE NULLIF(ti.metadata->>'m1_tactical_route', '')
            WHEN 'M1_TREND_CONTINUATION' THEN 'TREND_CONTINUATION'
            WHEN 'M1_CONFIRMED_REVERSAL' THEN 'CONFIRMED_REVERSAL'
            WHEN 'M1_EARLY_TRANSITION' THEN 'EARLY_TRANSITION'
            ELSE NULLIF(ti.metadata->>'m1_tactical_route', '')
          END
        ) AS strategy_route,
        COALESCE(
          NULLIF(ca.sizing_inputs->>'finalRiskAtStop', '')::numeric,
          NULLIF(ca.sizing_inputs->>'riskAmount', '')::numeric
        ) AS initial_risk_pnl,
        t.stop_loss,
        (
          COALESCE(ti.metadata->>'m1_rollout_phase', '') <> ''
          OR COALESCE(ti.metadata->>'timeframe', '') = 'M1'
          OR COALESCE(ti.strategy_code, '') LIKE '%multimodel%'
        ) AS is_m1_strategy
      FROM trading.trades t
      LEFT JOIN trading.trade_intents ti ON ti.id = t.trade_intent_id
      LEFT JOIN LATERAL (
        SELECT sizing_inputs
        FROM trading.capital_allocations ca0
        WHERE ca0.trade_intent_id = t.trade_intent_id
        ORDER BY ca0.created_at DESC
        LIMIT 1
      ) ca ON true
      WHERE t.status = 'OPEN'
        AND t.signal_id IS NOT NULL
        AND (t.external_position_id IS NOT NULL OR t.external_order_id IS NOT NULL)
      ORDER BY t.opened_at ASC
    `)) as OpenAiTradeRow[];
  }

  private async loadLatestAiThesis(
    trade: OpenAiTradeRow,
    observedAt: Date,
  ): Promise<LiveDemoAuthoritativeThesis | null> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          direction,
          evaluated_at,
          execution_authority,
          blockers,
          governance,
          COALESCE(
            NULLIF(governance->'multimodelEnsemble'->>'strategyRoute', ''),
            CASE route
              WHEN 'M1_TREND_CONTINUATION' THEN 'TREND_CONTINUATION'
              WHEN 'M1_CONFIRMED_REVERSAL' THEN 'CONFIRMED_REVERSAL'
              WHEN 'M1_EARLY_TRANSITION' THEN 'EARLY_TRANSITION'
              ELSE NULL
            END
          ) AS plan_b_strategy_route,
          COALESCE(
            NULLIF(governance->'multimodelAuthority'->>'executable', '')::boolean,
            false
          ) AS authority_executable,
          NULLIF(governance->'multimodelTrainedExpert'->>'direction', '') AS expert_direction,
          COALESCE(
            NULLIF(governance->'multimodelTrainedExpert'->>'allBrokerNative', '')::boolean,
            false
          ) AS expert_all_broker_native,
          COALESCE(
            NULLIF(governance->'multimodelTrainedExpert'->>'longVotes', '')::int,
            0
          ) AS expert_long_votes,
          COALESCE(
            NULLIF(governance->'multimodelTrainedExpert'->>'shortVotes', '')::int,
            0
          ) AS expert_short_votes,
          NULLIF(
            governance->'multimodelTrainedExpert'->>'ensembleConfidence',
            ''
          )::numeric AS expert_ensemble_confidence,
          NULLIF(
            governance->'multimodelTrainedExpert'->>'freshnessSeconds',
            ''
          )::numeric AS expert_freshness_seconds
        FROM trading.m1_tactical_decisions
        WHERE user_id = $1
          AND broker_connection_id = $2
          AND instrument = $3
          AND evaluated_at <= $4::timestamptz
          AND evaluated_at >= $4::timestamptz - interval '150 seconds'
        ORDER BY
          evaluated_at DESC,
          CASE WHEN execution_authority = 'BROKER_NATIVE' THEN 0 ELSE 1 END,
          CASE WHEN COALESCE(governance->'routeDecision'->>'eligible', 'false') = 'true' THEN 0 ELSE 1 END,
          CASE WHEN route <> 'ABSTAIN' THEN 0 ELSE 1 END,
          created_at DESC
        LIMIT 1
      `,
      [
        trade.user_id,
        trade.broker_connection_id,
        trade.instrument.toUpperCase(),
        observedAt.toISOString(),
      ],
    )) as Array<{
      direction: string;
      evaluated_at: Date | string;
      execution_authority: string;
      blockers: unknown;
      governance: unknown;
      plan_b_strategy_route: string | null;
      authority_executable: boolean | string | number | null;
      expert_direction: string | null;
      expert_all_broker_native: boolean | string | number | null;
      expert_long_votes: number | string | null;
      expert_short_votes: number | string | null;
      expert_ensemble_confidence: number | string | null;
      expert_freshness_seconds: number | string | null;
    }>;
    const row = rows[0];
    if (!row || (row.direction !== 'BUY' && row.direction !== 'SELL')) return null;
    const evaluatedAt = new Date(row.evaluated_at);
    if (!Number.isFinite(evaluatedAt.getTime())) return null;

    let blockers: string[] = [];
    if (Array.isArray(row.blockers)) {
      blockers = row.blockers.filter((value): value is string => typeof value === 'string');
    } else if (typeof row.blockers === 'string') {
      try {
        const parsed = JSON.parse(row.blockers) as unknown;
        if (Array.isArray(parsed)) {
          blockers = parsed.filter((value): value is string => typeof value === 'string');
        }
      } catch {
        blockers = [];
      }
    }

    let governance: Record<string, unknown> = {};
    if (row.governance && typeof row.governance === 'object' && !Array.isArray(row.governance)) {
      governance = row.governance as Record<string, unknown>;
    } else if (typeof row.governance === 'string') {
      try {
        const parsed = JSON.parse(row.governance) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          governance = parsed as Record<string, unknown>;
        }
      } catch {
        governance = {};
      }
    }
    const record = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const ensemble = record(governance.multimodelEnsemble);
    const authority = record(governance.multimodelAuthority);
    const expertJson = record(governance.multimodelTrainedExpert);
    const routeValue = row.plan_b_strategy_route ?? ensemble.strategyRoute;
    const route =
      routeValue === 'TREND_CONTINUATION' ||
      routeValue === 'CONFIRMED_REVERSAL' ||
      routeValue === 'EARLY_TRANSITION'
        ? routeValue
        : null;
    const expertDirectionValue = row.expert_direction ?? expertJson.direction;
    const expertDirection =
      expertDirectionValue === 'BUY' || expertDirectionValue === 'SELL'
        ? expertDirectionValue
        : null;
    const expertConfidence = finite(
      row.expert_ensemble_confidence ?? expertJson.ensembleConfidence,
    );
    const expertFreshness = finite(row.expert_freshness_seconds ?? expertJson.freshnessSeconds);
    const longVotes = finite(row.expert_long_votes ?? expertJson.longVotes) ?? 0;
    const shortVotes = finite(row.expert_short_votes ?? expertJson.shortVotes) ?? 0;
    const bool = (value: unknown): boolean =>
      value === true || value === 'true' || value === 1 || value === '1';

    return {
      direction: row.direction,
      evaluatedAt,
      executionAuthority: String(row.execution_authority ?? ''),
      blockers,
      planBStrategyRoute: route,
      authorityExecutable: bool(row.authority_executable ?? authority.executable),
      trainedExpert: expertDirection
        ? {
            direction: expertDirection,
            allBrokerNative: bool(row.expert_all_broker_native ?? expertJson.allBrokerNative),
            longVotes,
            shortVotes,
            ensembleConfidence: expertConfidence,
            freshnessSeconds: expertFreshness,
          }
        : null,
    };
  }

  private async loadPositionSideAlignmentWithinDeadline(
    trade: OpenAiTradeRow,
    observedAt: Date,
  ): Promise<{ m5Aligned: number | null; m15Aligned: number | null; observedAt: Date } | null> {
    // A broken/slow diagnostic query must never postpone the original
    // protective broker close for an indefinite period.
    let deadline: NodeJS.Timeout | null = null;
    try {
      const timeout = new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), 500);
      });
      return await Promise.race([this.loadRecentPositionSideAlignment(trade, observedAt), timeout]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  private async loadRecentPositionSideAlignment(
    trade: OpenAiTradeRow,
    observedAt: Date,
  ): Promise<{ m5Aligned: number | null; m15Aligned: number | null; observedAt: Date } | null> {
    // Same-side existing-trade trend context is NOT a new entry authority.
    // Use only decisions actually persisted before this close checkpoint.
    const rows = (await this.dataSource.query(
      `
        SELECT created_at, candidate->>'alignedM5' AS aligned_m5,
          candidate->>'alignedM15' AS aligned_m15
        FROM trading.m1_tactical_decisions
        WHERE user_id = $1 AND broker_connection_id = $2
          AND instrument = $3 AND direction = $4
          AND created_at <= $5::timestamptz
          AND created_at >= $5::timestamptz - interval '150 seconds'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [
        trade.user_id,
        trade.broker_connection_id,
        trade.instrument.toUpperCase(),
        trade.direction,
        observedAt.toISOString(),
      ],
    )) as Array<{
      created_at: Date | string;
      aligned_m5: string | number | null;
      aligned_m15: string | number | null;
    }>;
    const row = rows[0];
    if (!row) return null;
    const timestamp = new Date(row.created_at);
    if (!Number.isFinite(timestamp.getTime())) return null;
    return {
      m5Aligned: row.aligned_m5 === null ? null : finite(row.aligned_m5),
      m15Aligned: row.aligned_m15 === null ? null : finite(row.aligned_m15),
      observedAt: timestamp,
    };
  }

  private async loadCausalM1Evidence(
    trade: OpenAiTradeRow,
    observedAt: Date,
  ): Promise<LiveDemoM1AdverseEvidence | null> {
    const rows = (await this.dataSource.query(
      `
        SELECT bucket_time, open, high, low, close, spread_close, sample_count, positive_quote_sample_count, last_quote_sample_at, source
        FROM market_data.provider_quote_candles
        WHERE connection_id = $1
          AND instrument = $2
          AND timeframe = 'M1'
          AND source = 'ctrader-broker-native'
          AND bucket_time + interval '1 minute' <= $3::timestamptz
        ORDER BY bucket_time DESC
        LIMIT 3
      `,
      [trade.broker_connection_id, trade.instrument.toUpperCase(), observedAt.toISOString()],
    )) as Array<{
      bucket_time: Date | string;
      open: string | number;
      high: string | number;
      low: string | number;
      close: string | number;
      sample_count: string | number;
      positive_quote_sample_count?: string | number;
      last_quote_sample_at?: Date | string | null;
      spread_close?: string | number | null;
      source: string;
    }>;
    if (!rows.length) return null;
    const sign = trade.direction === 'BUY' ? 1 : -1;
    const parsed = rows.flatMap((row) => {
      const open = finite(row.open);
      const high = finite(row.high);
      const low = finite(row.low);
      const close = finite(row.close);
      const samples = finite(row.sample_count);
      const bucketTime = new Date(row.bucket_time);
      const liveQuoteAt = row.last_quote_sample_at ? new Date(row.last_quote_sample_at) : null;
      const hasLiveQuote = Boolean(
        (finite(row.positive_quote_sample_count) ?? 0) > 0 &&
        liveQuoteAt &&
        Number.isFinite(liveQuoteAt.getTime()) &&
        liveQuoteAt.getTime() >= bucketTime.getTime() &&
        liveQuoteAt.getTime() < bucketTime.getTime() + 60_000 &&
        liveQuoteAt.getTime() <= observedAt.getTime(),
      );
      if (
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        samples === null ||
        samples <= 0 ||
        row.source !== 'ctrader-broker-native' ||
        !Number.isFinite(bucketTime.getTime())
      ) {
        return [];
      }
      const range = Math.max(high - low, Number.EPSILON);
      return [
        {
          open,
          high,
          low,
          close,
          bucketTime,
          alignedBodyPressure: sign * ((close - open) / range),
          hasLiveQuote,
          spreadPrice: row.spread_close == null ? null : finite(row.spread_close),
          range,
        },
      ];
    });
    if (!parsed.length) return null;
    const latest = parsed[0]!;
    const oldest = parsed[parsed.length - 1]!;
    const totalRange = parsed.reduce((sum, row) => sum + row.range, 0);
    const alignedMomentum3 =
      totalRange > 0 ? sign * ((latest.close - oldest.open) / totalRange) : 0;
    const latestCloseAt = latest.bucketTime.getTime() + 60_000;
    let consecutiveLiveQuoteBars = 0;
    for (const row of parsed) {
      if (
        !row.hasLiveQuote ||
        row.bucketTime.getTime() !== latest.bucketTime.getTime() - consecutiveLiveQuoteBars * 60_000
      )
        break;
      consecutiveLiveQuoteBars++;
    }
    return {
      completedBars: parsed.length,
      adverseBars: parsed.filter((row) => row.alignedBodyPressure <= -0.15).length,
      liveQuoteBars: parsed.filter((row) => row.hasLiveQuote).length,
      consecutiveLiveQuoteBars,
      latestLiveSpreadPrice: latest.hasLiveQuote ? latest.spreadPrice : null,
      alignedLatestBodyPressure: latest.alignedBodyPressure,
      alignedMomentum3,
      latestAgeSeconds: (observedAt.getTime() - latestCloseAt) / 1000,
    };
  }

  private async persistTelemetry(input: {
    tradeId: string;
    maxFavorablePnl: number;
    maxAdversePnl: number;
    profitGiveback: number;
    observationCount: number;
    peakObservedAt: Date;
    observedAt: Date;
  }): Promise<void> {
    await this.dataSource.query(
      `
        UPDATE trading.trades
        SET max_favorable_pnl = $2,
            max_adverse_pnl = $3,
            profit_giveback = $4,
            path_observation_count = $5,
            path_peak_observed_at = $6,
            path_last_observed_at = $7,
            updated_at = now()
        WHERE id = $1
          AND status = 'OPEN'
      `,
      [
        input.tradeId,
        money(input.maxFavorablePnl),
        money(input.maxAdversePnl),
        money(input.profitGiveback),
        input.observationCount,
        input.peakObservedAt,
        input.observedAt,
      ],
    );
  }
}
