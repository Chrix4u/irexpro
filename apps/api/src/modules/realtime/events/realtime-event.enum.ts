/**
 * RealtimeEvent — typed server-to-client WebSocket event names.
 *
 * Payload safety rules (enforced in RealtimeService):
 * - NEVER include broker credentials or encrypted secrets
 * - NEVER include raw access/refresh tokens
 * - NEVER include full internal error stack traces
 * - Use safe IDs, statuses, timestamps, reason codes and user-facing messages only
 *
 * See: docs/architecture/06-realtime-event-layer.md
 */
export enum RealtimeEvent {
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

  // Risk decisions
  RISK_SIGNAL_APPROVED = 'risk.signal.approved',
  RISK_SIGNAL_REJECTED = 'risk.signal.rejected',

  // Broker connection
  BROKER_CONNECTION_STATUS_CHANGED = 'broker.connection.status_changed',
  // Sprint 50 — authorization state machine transitions
  BROKER_AUTHORIZATION_CHANGED = 'broker.connection.authorization_changed',
  // Sprint 50 — emergency control plane changes
  EXECUTION_CONTROL_CHANGED = 'execution.control.changed',

  // Subscription
  SUBSCRIPTION_STATUS_CHANGED = 'subscription.status_changed',

  // AI signals
  AI_SIGNAL_RECEIVED = 'ai.signal.received',
  AI_SIGNAL_IGNORED = 'ai.signal.ignored',

  // System
  SYSTEM_NOTIFICATION = 'system.notification',

  // Connection management (client-to-server ACK events)
  CONNECTION_ESTABLISHED = 'connection.established',
}
