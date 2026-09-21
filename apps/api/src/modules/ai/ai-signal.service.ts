import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { StrategyOrchestratorService } from '../strategy/strategy-orchestrator.service';
// Round 6 live-execution completion (§10): the serialized AI exit pipeline.
import { AiExitOrchestratorService } from '../strategy/ai-exit-orchestrator.service';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { AiSignalCandidate } from './interfaces/ai-signal-candidate.interface';
import { StrategyResult } from '../strategy/interfaces/strategy.interface';
import { AiExitResult, AiExitSignal } from '../strategy/interfaces/ai-exit-signal.interface';

const AGENT_CONTEXT_STATUSES = new Set(['ALIGNED', 'CONFLICT', 'INSUFFICIENT', 'BLOCKED']);
const AGENT_CONTEXT_DIRECTIONS = new Set(['BUY', 'SELL', 'NEUTRAL']);
const AGENT_CONTEXT_SOURCE_STATES = new Set(['AVAILABLE', 'UNAVAILABLE', 'NOT_APPLICABLE']);
const AGENT_CONTEXT_SOURCES = new Set(['QUANT', 'MACRO_NEWS', 'REGIME', 'RISK', 'REFLECTION']);
const AGENT_CONTEXT_STANCES = new Set(['BUY', 'SELL', 'NEUTRAL', 'BLOCK']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function boundedInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  return Number.isInteger(value) && typeof value === 'number' && value >= min && value <= max
    ? value
    : null;
}

function isoString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function sanitizeAgentContext(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 'agent-council-v1' ||
    typeof value.status !== 'string' ||
    !AGENT_CONTEXT_STATUSES.has(value.status) ||
    typeof value.consensusDirection !== 'string' ||
    !AGENT_CONTEXT_DIRECTIONS.has(value.consensusDirection) ||
    typeof value.sourceState !== 'string' ||
    !AGENT_CONTEXT_SOURCE_STATES.has(value.sourceState) ||
    value.advisoryOnly !== true ||
    value.executionAuthority !== false
  ) {
    return null;
  }

  const weightedSupport = finiteNumber(value.weightedSupport);
  const weightedOpposition = finiteNumber(value.weightedOpposition);
  const disagreementScore = finiteNumber(value.disagreementScore, 0, 1);
  const evidenceCount = boundedInteger(value.evidenceCount, 0, 100);
  const rejectedCount = boundedInteger(value.rejectedCount, 0);
  const evaluatedAt = isoString(value.evaluatedAt);
  if (
    weightedSupport === null ||
    weightedOpposition === null ||
    disagreementScore === null ||
    evidenceCount === null ||
    rejectedCount === null ||
    evaluatedAt === null ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 10
  ) {
    return null;
  }

  const evidence: Record<string, unknown>[] = [];
  for (const raw of value.evidence) {
    if (!isRecord(raw)) return null;
    const confidence = finiteNumber(raw.confidence, 0, 1);
    const credibility = finiteNumber(raw.credibility, 0, 1);
    const verifiedSources = boundedInteger(raw.verifiedSources, 0, 100);
    const availableAt = isoString(raw.availableAt);
    if (
      typeof raw.source !== 'string' ||
      !AGENT_CONTEXT_SOURCES.has(raw.source) ||
      typeof raw.sourceId !== 'string' ||
      raw.sourceId.length < 1 ||
      raw.sourceId.length > 160 ||
      typeof raw.stance !== 'string' ||
      !AGENT_CONTEXT_STANCES.has(raw.stance) ||
      confidence === null ||
      credibility === null ||
      verifiedSources === null ||
      availableAt === null ||
      typeof raw.summary !== 'string' ||
      raw.summary.length < 1 ||
      raw.summary.length > 500
    ) {
      return null;
    }

    evidence.push({
      source: raw.source,
      sourceId: raw.sourceId,
      stance: raw.stance,
      confidence,
      credibility,
      verifiedSources,
      availableAt,
      summary: raw.summary,
    });
  }

  if (
    value.sourceState !== 'AVAILABLE' &&
    (value.status !== 'INSUFFICIENT' || evidenceCount !== 0 || evidence.length !== 0)
  ) {
    return null;
  }

  return {
    version: 'agent-council-v1',
    status: value.status,
    consensusDirection: value.consensusDirection,
    weightedSupport,
    weightedOpposition,
    disagreementScore,
    evidenceCount,
    rejectedCount,
    evidence,
    sourceState: value.sourceState,
    evaluatedAt,
    advisoryOnly: true,
    executionAuthority: false,
  };
}

/**
 * AiSignalService — Safe signal intake service for the AI Signal Engine.
 *
 * This service is the NestJS entry point for signals generated by Python
 * AI microservices (or DEV simulation). It validates, logs, and forwards
 * signals to the Strategy Orchestrator.
 *
 * CRITICAL INVARIANT:
 *   Signals are NEVER sent directly to ExecutionService or BrokerAdapter.
 *   All signals must pass through StrategyOrchestratorService.
 */
@Injectable()
export class AiSignalService {
  private readonly logger = new Logger(AiSignalService.name);

  constructor(
    private readonly strategyOrchestrator: StrategyOrchestratorService,
    // Round 6 §10: exits route through their OWN serialized orchestrator —
    // risk-reducing decisions never enter the NEW-exposure pipeline.
    private readonly exitOrchestrator: AiExitOrchestratorService,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
  ) {}

  /**
   * Primary entry point. Validates and forwards to Strategy Orchestrator.
   */
  async receiveSignal(candidate: AiSignalCandidate): Promise<StrategyResult> {
    this.logger.log(
      `Signal received: id=${candidate.signalId} user=${candidate.userId} ` +
        `instrument=${candidate.instrument} direction=${candidate.direction}`,
    );

    const safeEvidence = this.buildSafeEvidence(candidate);
    const validationError = this.validateCandidate(candidate);
    if (validationError) {
      this.logger.warn(`Signal ${candidate.signalId} validation failed: ${validationError}`);
      await this.auditService.log({
        actorUserId: candidate.userId,
        action: AuditAction.AI_SIGNAL_RECEIVED,
        severity: AuditSeverity.INFO,
        resourceType: 'AiSignal',
        resourceId: candidate.signalId,
        metadata: {
          ...safeEvidence,
          validationError,
        },
      });
      return {
        outcome: 'SIGNAL_INVALID',
        signalId: candidate.signalId,
        reason: validationError,
      };
    }

    await this.auditService.log({
      actorUserId: candidate.userId,
      action: AuditAction.AI_SIGNAL_RECEIVED,
      severity: AuditSeverity.INFO,
      resourceType: 'AiSignal',
      resourceId: candidate.signalId,
      metadata: safeEvidence,
    });

    this.eventBus.publish(DomainEventType.AI_SIGNAL_RECEIVED, candidate.userId, {
      signalId: candidate.signalId,
      instrument: candidate.instrument,
      direction: candidate.direction,
      confidenceScore: candidate.confidenceScore,
      strategyCode: candidate.strategyCode,
    });

    return this.forwardToStrategyOrchestrator(candidate);
  }

  /**
   * Validate the structural integrity of a signal candidate.
   * Returns null if valid, or an error message string.
   */
  validateCandidate(candidate: AiSignalCandidate): string | null {
    if (!candidate.signalId) return 'Missing signalId';
    if (!candidate.userId) return 'Missing userId';
    if (!candidate.tradingSessionId) return 'Missing tradingSessionId';
    if (!candidate.brokerConnectionId) return 'Missing brokerConnectionId';
    if (!candidate.instrument || candidate.instrument.length < 3) return 'Invalid instrument';
    if (!['BUY', 'SELL'].includes(candidate.direction)) return 'Invalid direction';
    if (
      typeof candidate.confidenceScore !== 'number' ||
      candidate.confidenceScore < 0 ||
      candidate.confidenceScore > 1
    ) {
      return 'confidenceScore must be 0–1';
    }
    if (!candidate.suggestedStopLoss || candidate.suggestedStopLoss <= 0)
      return 'Invalid suggestedStopLoss';
    if (!candidate.suggestedTakeProfit || candidate.suggestedTakeProfit <= 0)
      return 'Invalid suggestedTakeProfit';
    if (!candidate.suggestedVolume || candidate.suggestedVolume <= 0)
      return 'Invalid suggestedVolume';
    if (!candidate.strategyCode) return 'Missing strategyCode';
    if (!candidate.modelVersion) return 'Missing modelVersion';
    return null;
  }

  /**
   * Forward a validated candidate to the Strategy Orchestrator.
   * Do NOT call ExecutionService directly from here.
   */
  async forwardToStrategyOrchestrator(candidate: AiSignalCandidate): Promise<StrategyResult> {
    return this.strategyOrchestrator.processSignal(candidate);
  }

  /**
   * Round 6 live-execution completion (§10): the AI EXIT intake — a
   * risk-reducing decision (close one trade / flatten an instrument).
   *
   * CRITICAL INVARIANT (same as entries): exits are NEVER sent directly to
   * ExecutionService or a BrokerAdapter — they route through the §10
   * serialized exit orchestrator (session gate → identity gate → per-user
   * serialization → closeTrade with AI_CLOSE_SIGNAL). Entry-signal
   * structural validation does NOT apply (no SL/TP/volume on an exit).
   */
  async receiveExitSignal(signal: AiExitSignal): Promise<AiExitResult> {
    this.logger.log(
      `Exit signal received: id=${signal.signalId} user=${signal.userId} ` +
        `instrument=${signal.instrument}` +
        (signal.tradeId ? ` trade=${signal.tradeId}` : ' (flatten instrument)'),
    );
    return this.exitOrchestrator.processExitSignal(signal);
  }

  /**
   * Build a signal candidate from the DEV simulate endpoint request.
   * Assigns a new signalId and generatedAt timestamp.
   */
  buildSimulatedCandidate(userId: string, dto: Partial<AiSignalCandidate>): AiSignalCandidate {
    return {
      signalId: uuidv4(),
      generatedAt: new Date(),
      ...dto,
      userId,
    } as AiSignalCandidate;
  }

  /**
   * Persist only explicit model provenance that is safe for later projection.
   * Opaque candidate.metadata is intentionally excluded from the audit record.
   */
  private buildSafeEvidence(candidate: AiSignalCandidate): Record<string, unknown> {
    const agentContext = sanitizeAgentContext(candidate.agentContext);
    if (candidate.agentContext && !agentContext) {
      this.logger.warn(
        `Signal ${candidate.signalId} supplied invalid advisory agent context; ignored`,
      );
    }

    return {
      instrument: candidate.instrument,
      direction: candidate.direction,
      confidenceScore: candidate.confidenceScore,
      strategyCode: candidate.strategyCode,
      modelVersion: candidate.modelVersion,
      timeframe: candidate.timeframe,
      generatedAt:
        candidate.generatedAt instanceof Date ? candidate.generatedAt.toISOString() : null,
      ...(candidate.marketRegime ? { marketRegime: candidate.marketRegime } : {}),
      ...(typeof candidate.volatilityScore === 'number'
        ? { volatilityScore: candidate.volatilityScore }
        : {}),
      ...(agentContext ? { agentContext } : {}),
    };
  }
}
