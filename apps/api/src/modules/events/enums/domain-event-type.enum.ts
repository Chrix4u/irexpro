/**
 * DomainEventType — typed event names for the in-memory DomainEventBus.
 *
 * These events decouple business modules (Execution, Risk, Broker, Trading)
 * from the RealtimeModule. Services publish events here; RealtimeService
 * subscribes and forwards them to WebSocket clients.
 *
 * Naming convention: <domain>.<noun>.<past-tense-verb>
 */
export enum DomainEventType {
  // Trading session lifecycle
  TRADING_SESSION_STARTED = 'trading.session.started',
  TRADING_SESSION_STOPPED = 'trading.session.stopped',

  // Trade lifecycle
  TRADE_PENDING = 'trade.pending',
  TRADE_OPENED = 'trade.opened',
  TRADE_REJECTED = 'trade.rejected',
  TRADE_CLOSED = 'trade.closed',
  TRADE_RECONCILIATION_PENDING = 'trade.reconciliation_pending',

  // Order lifecycle (Sprint 50 PR-3 — execution orchestration slice)
  ORDER_SUBMITTED = 'order.submitted',
  ORDER_ACKNOWLEDGED = 'order.acknowledged',
  ORDER_FILLED = 'order.filled',
  ORDER_REJECTED = 'order.rejected',
  ORDER_RECONCILIATION_PENDING = 'order.reconciliation_pending',

  // State reconciliation (Sprint 50 PR-4 — internal state vs provider state)
  RECONCILIATION_RUN_COMPLETED = 'reconciliation.run.completed',
  RECONCILIATION_DISCREPANCY_DETECTED = 'reconciliation.discrepancy.detected',
  RECONCILIATION_DISCREPANCY_RESOLVED = 'reconciliation.discrepancy.resolved',

  // Risk decisions
  RISK_SIGNAL_APPROVED = 'risk.signal.approved',
  RISK_SIGNAL_REJECTED = 'risk.signal.rejected',

  // Broker connection
  BROKER_STATUS_CHANGED = 'broker.connection.status_changed',
  // Sprint 50 — authorization state machine transitions
  BROKER_AUTHORIZATION_CHANGED = 'broker.connection.authorization_changed',

  // Sprint 50 — emergency control plane
  EXECUTION_CONTROL_CHANGED = 'execution.control.changed',

  // Subscription
  SUBSCRIPTION_STATUS_CHANGED = 'subscription.status_changed',

  // AI signals
  AI_SIGNAL_RECEIVED = 'ai.signal.received',
  AI_SIGNAL_IGNORED = 'ai.signal.ignored',

  // System notifications
  SYSTEM_NOTIFICATION = 'system.notification',
}
