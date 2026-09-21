import { Injectable } from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { Trade } from '../execution/entities/trade.entity';
import { ExecutionReadService } from '../execution/execution-read.service';
import {
  AiDecisionAgentContextDto,
  AiDecisionExplorerResponseDto,
  AiDecisionOutcome,
  AiDecisionStageStatus,
  AiDecisionSummaryDto,
  AiDecisionTimelineEntryDto,
} from './dto/ai-decision-explorer-response.dto';

function metadataString(log: AuditLog, key: string): string | null {
  const value = log.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function metadataNumber(log: AuditLog, key: string): number | null {
  const value = log.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function integerNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function isoString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function metadataAgentContext(log: AuditLog): AiDecisionAgentContextDto | null {
  const raw = log.metadata?.agentContext;
  if (!isRecord(raw)) return null;

  const statuses = new Set(['ALIGNED', 'CONFLICT', 'INSUFFICIENT', 'BLOCKED']);
  const directions = new Set(['BUY', 'SELL', 'NEUTRAL']);
  const sourceStates = new Set(['AVAILABLE', 'UNAVAILABLE', 'NOT_APPLICABLE']);
  const sources = new Set(['QUANT', 'MACRO_NEWS', 'REGIME', 'RISK', 'REFLECTION']);
  const stances = new Set(['BUY', 'SELL', 'NEUTRAL', 'BLOCK']);

  if (
    raw.version !== 'agent-council-v1' ||
    typeof raw.status !== 'string' ||
    !statuses.has(raw.status) ||
    typeof raw.consensusDirection !== 'string' ||
    !directions.has(raw.consensusDirection) ||
    typeof raw.sourceState !== 'string' ||
    !sourceStates.has(raw.sourceState) ||
    raw.advisoryOnly !== true ||
    raw.executionAuthority !== false
  ) {
    return null;
  }

  const weightedSupport = finiteNumber(raw.weightedSupport);
  const weightedOpposition = finiteNumber(raw.weightedOpposition);
  const disagreementScore = finiteNumber(raw.disagreementScore, 0, 1);
  const evidenceCount = integerNumber(raw.evidenceCount, 0, 100);
  const rejectedCount = integerNumber(raw.rejectedCount);
  const evaluatedAt = isoString(raw.evaluatedAt);
  if (
    weightedSupport === null ||
    weightedOpposition === null ||
    disagreementScore === null ||
    evidenceCount === null ||
    rejectedCount === null ||
    evaluatedAt === null ||
    !Array.isArray(raw.evidence) ||
    raw.evidence.length > 10
  ) {
    return null;
  }

  const evidence: AiDecisionAgentContextDto['evidence'] = [];
  for (const item of raw.evidence) {
    if (!isRecord(item)) return null;
    const confidence = finiteNumber(item.confidence, 0, 1);
    const credibility = finiteNumber(item.credibility, 0, 1);
    const verifiedSources = integerNumber(item.verifiedSources, 0, 100);
    const availableAt = isoString(item.availableAt);
    if (
      typeof item.source !== 'string' ||
      !sources.has(item.source) ||
      typeof item.sourceId !== 'string' ||
      item.sourceId.length < 1 ||
      item.sourceId.length > 160 ||
      typeof item.stance !== 'string' ||
      !stances.has(item.stance) ||
      confidence === null ||
      credibility === null ||
      verifiedSources === null ||
      availableAt === null ||
      typeof item.summary !== 'string' ||
      item.summary.length < 1 ||
      item.summary.length > 500
    ) {
      return null;
    }

    evidence.push({
      source: item.source as AiDecisionAgentContextDto['evidence'][number]['source'],
      sourceId: item.sourceId,
      stance: item.stance as AiDecisionAgentContextDto['evidence'][number]['stance'],
      confidence,
      credibility,
      verifiedSources,
      availableAt,
      summary: item.summary,
    });
  }

  if (
    raw.sourceState !== 'AVAILABLE' &&
    (raw.status !== 'INSUFFICIENT' || evidenceCount !== 0 || evidence.length !== 0)
  ) {
    return null;
  }

  return {
    version: 'agent-council-v1',
    status: raw.status as AiDecisionAgentContextDto['status'],
    consensusDirection: raw.consensusDirection as AiDecisionAgentContextDto['consensusDirection'],
    weightedSupport,
    weightedOpposition,
    disagreementScore,
    evidenceCount,
    rejectedCount,
    evidence,
    sourceState: raw.sourceState as AiDecisionAgentContextDto['sourceState'],
    evaluatedAt,
    advisoryOnly: true,
    executionAuthority: false,
  };
}

function metadataDirection(log: AuditLog): 'BUY' | 'SELL' | null {
  const value = metadataString(log, 'direction');
  return value === 'BUY' || value === 'SELL' ? value : null;
}

function signalIdFor(log: AuditLog): string | null {
  if (log.resourceType === 'AiSignal' && log.resourceId) return log.resourceId;
  return metadataString(log, 'signalId');
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

@Injectable()
export class AiDecisionExplorerService {
  constructor(
    private readonly auditService: AuditService,
    private readonly executionReadService: ExecutionReadService,
  ) {}

  async getRecentDecisions(userId: string, limit = 25): Promise<AiDecisionExplorerResponseDto> {
    const receipts = await this.auditService.listRecentAiSignalReceipts(userId, limit);
    const signalIds = receipts
      .map((receipt) => receipt.resourceId)
      .filter((id): id is string => !!id);

    const [lifecycle, trades] = await Promise.all([
      this.auditService.listAiSignalLifecycle(userId, signalIds),
      this.executionReadService.listBySignalIds(userId, signalIds),
    ]);

    const logsBySignal = new Map<string, AuditLog[]>();
    for (const log of lifecycle) {
      const signalId = signalIdFor(log);
      if (!signalId || !signalIds.includes(signalId)) continue;
      const current = logsBySignal.get(signalId) ?? [];
      current.push(log);
      logsBySignal.set(signalId, current);
    }

    const tradeBySignal = new Map<string, Trade>();
    for (const trade of trades) {
      if (trade.signalId && signalIds.includes(trade.signalId)) {
        tradeBySignal.set(trade.signalId, trade);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      decisions: receipts
        .filter((receipt): receipt is AuditLog & { resourceId: string } => !!receipt.resourceId)
        .map((receipt) =>
          this.buildDecision(
            receipt.resourceId,
            receipt,
            logsBySignal.get(receipt.resourceId) ?? [receipt],
            tradeBySignal.get(receipt.resourceId) ?? null,
          ),
        ),
    };
  }

  private buildDecision(
    signalId: string,
    receipt: AuditLog,
    lifecycle: AuditLog[],
    trade: Trade | null,
  ): AiDecisionSummaryDto {
    const ordered = [...lifecycle].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let outcome: AiDecisionOutcome = 'RECEIVED';
    let riskDecision: 'APPROVED' | 'REJECTED' | 'UNKNOWN' = 'UNKNOWN';
    let rejectionCode: string | null = null;
    let rejectionReason: string | null = null;

    const timeline: AiDecisionTimelineEntryDto[] = [];
    for (const log of ordered) {
      const entry = this.toTimelineEntry(log);
      if (entry) timeline.push(entry);

      switch (log.action) {
        case AuditAction.AI_SIGNAL_IGNORED:
          outcome = 'IGNORED';
          break;
        case AuditAction.AI_SIGNAL_RISK_APPROVED:
          outcome = 'RISK_APPROVED';
          riskDecision = 'APPROVED';
          break;
        case AuditAction.AI_SIGNAL_RISK_REJECTED:
          outcome = 'RISK_REJECTED';
          riskDecision = 'REJECTED';
          rejectionCode = metadataString(log, 'rejectionCode');
          rejectionReason = metadataString(log, 'rejectionReason');
          break;
        case AuditAction.AI_SIGNAL_EXECUTED:
          outcome = 'EXECUTION_SUCCEEDED';
          break;
        case AuditAction.AI_SIGNAL_EXECUTION_FAILED:
          outcome = 'EXECUTION_FAILED';
          break;
      }
    }

    return {
      signalId,
      outcome,
      receivedAt: receipt.createdAt.toISOString(),
      evidence: {
        instrument: metadataString(receipt, 'instrument'),
        direction: metadataDirection(receipt),
        confidenceScore: metadataNumber(receipt, 'confidenceScore'),
        strategyCode: metadataString(receipt, 'strategyCode'),
        modelVersion: metadataString(receipt, 'modelVersion'),
        timeframe: metadataString(receipt, 'timeframe'),
        marketRegime: metadataString(receipt, 'marketRegime'),
        volatilityScore: metadataNumber(receipt, 'volatilityScore'),
        generatedAt: metadataString(receipt, 'generatedAt'),
      },
      agentContext: metadataAgentContext(receipt),
      risk: {
        decision: riskDecision,
        rejectionCode,
        rejectionReason,
      },
      execution: trade
        ? {
            tradeId: trade.id,
            status: trade.status,
            openedAt: toIso(trade.openedAt),
            closedAt: toIso(trade.closedAt),
            closeReason: trade.closeReason,
          }
        : null,
      timeline,
    };
  }

  private toTimelineEntry(log: AuditLog): AiDecisionTimelineEntryDto | null {
    let stage: AiDecisionTimelineEntryDto['stage'];
    let status: AiDecisionStageStatus;
    let code: string | null = null;
    let message: string;

    switch (log.action) {
      case AuditAction.AI_SIGNAL_RECEIVED:
        stage = 'SIGNAL';
        status = 'RECEIVED';
        message = 'AI signal received';
        break;
      case AuditAction.AI_SIGNAL_IGNORED:
        stage = 'ELIGIBILITY';
        status = 'REJECTED';
        code = metadataString(log, 'reasonCode');
        message = metadataString(log, 'reasonSummary') ?? 'Signal did not pass an eligibility gate';
        break;
      case AuditAction.AI_SIGNAL_RISK_APPROVED:
        stage = 'RISK';
        status = 'APPROVED';
        message = 'Risk engine approved the signal';
        break;
      case AuditAction.AI_SIGNAL_RISK_REJECTED:
        stage = 'RISK';
        status = 'REJECTED';
        code = metadataString(log, 'rejectionCode');
        message = metadataString(log, 'rejectionReason') ?? 'Risk engine rejected the signal';
        break;
      case AuditAction.AI_SIGNAL_EXECUTED:
        stage = 'EXECUTION';
        status = 'SUCCEEDED';
        message = 'Execution engine accepted the approved signal';
        break;
      case AuditAction.AI_SIGNAL_EXECUTION_FAILED:
        stage = 'EXECUTION';
        status = 'FAILED';
        message = 'Execution failed after risk approval';
        break;
      default:
        return null;
    }

    return {
      stage,
      status,
      code,
      message,
      at: log.createdAt.toISOString(),
    };
  }
}
