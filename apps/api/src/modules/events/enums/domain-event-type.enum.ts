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
