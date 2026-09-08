import { DomainEventType } from '../enums/domain-event-type.enum';

/**
 * Base interface for all domain events published on the DomainEventBus.
 *
 * Payload rules:
 * - NEVER include broker credentials or encrypted secrets
 * - NEVER include raw tokens (access/refresh)
 * - NEVER include full internal error stack traces
 * - Use safe IDs, statuses, timestamps, reason codes, and user-facing messages
 */
export interface DomainEvent<T = Record<string, unknown>> {
  type: DomainEventType;
  userId: string;
  payload: T;
  timestamp: Date;
}

// ─── Typed payload interfaces ──────────────────────────────────────────────────

export interface TradingSessionEventPayload {
  sessionId: string;
  userId: string;
  brokerConnectionId: string;
  status: string;
  startedAt?: Date;
  endedAt?: Date;
}

export interface TradeEventPayload {
  tradeId: string;
  userId: string;
  sessionId?: string;
  instrument: string;
  direction: string;
  volume: string;
  status: string;
  entryPrice?: string;
  exitPrice?: string;
  realisedPnl?: string;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Sprint 50 PR-3 — normalized order lifecycle event (safe fields only).
 * Mirrors the frontend-safe OrderView projection: decimal strings, no
 * idempotency keys, no broker connection internals.
 */
export interface OrderEventPayload {
  orderId: string;
  userId: string;
  clientOrderId: string;
  tradeId?: string | null;
  signalId?: string | null;
  instrument: string;
  direction: string;
  orderKind: string;
  status: string;
  requestedQuantity: string;
  filledQuantity?: string;
  avgFillPrice?: string;
  providerOrderId?: string | null;
  reason?: string;
}

export interface RiskDecisionEventPayload {
  userId: string;
  sessionId?: string;
  instrument: string;
  direction: string;
  decision: 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  rejectionCode?: string;
  rejectionReason?: string;
  idempotencyKey?: string;
}

export interface BrokerStatusEventPayload {
  userId: string;
  connectionId: string;
  status: string;
  previousStatus?: string;
  reason?: string;
}

/** Sprint 50 — authorization state machine transition (safe fields only). */
export interface BrokerAuthorizationEventPayload {
  userId: string;
  connectionId: string;
  brokerId?: string;
  status: string;
  previousStatus?: string;
}

/** Sprint 50 — emergency control plane change (safe fields only). */
export interface ExecutionControlEventPayload {
  scope: string;
  scopeKey?: string | null;
  action: 'activated' | 'deactivated';
  reason?: string;
}

export interface AiSignalEventPayload {
  signalId: string;
  userId: string;
  sessionId?: string;
  instrument: string;
  direction: string;
  confidenceScore: number;
  strategyCode: string;
  ignoredReason?: string;
}

export interface SystemNotificationPayload {
  userId: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  code?: string;
}

// ─── State reconciliation (Sprint 50 PR-4) ──────────────────────────────────

/**
 * Frontend-safe payload for a completed reconciliation run. Counters and
 * identities only — no credentials, no raw provider payloads.
 */
export interface ReconciliationRunEventPayload {
  userId: string;
  runId: string;
  brokerConnectionId: string;
  brokerId: string;
  status: string;
  discrepanciesDetected: number;
  discrepanciesNew: number;
  discrepanciesOpen: number;
  completedAt: string;
}

/**
 * Frontend-safe payload for ONE discrepancy lifecycle event (detected or
 * resolved). Identity + classification only; `details` stays server-side
 * (user APIs expose a curated projection later — PR-5).
 */
export interface ReconciliationDiscrepancyEventPayload {
  userId: string;
  discrepancyId: string;
  brokerConnectionId: string;
  type: string;
  severity: string;
  internalRefType?: string | null;
  internalRefId?: string | null;
  providerRef?: string | null;
  clientOrderId?: string | null;
  /** ISO timestamp of detection (detected) or resolution (resolved). */
  at: string;
}
