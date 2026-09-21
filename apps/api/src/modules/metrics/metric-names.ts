/**
 * Round 7 (P1 metrics — audit R7-audit-C finding A6): the well-known metric
 * name catalog for the dependency-free, in-process metrics pipeline.
 *
 * Design contract:
 *  - MetricsService.increment() accepts ANY name (unknown names are accepted,
 *    sanitized and counted), but production instrumentation MUST use these
 *    constants so the catalog stays greppable and the /metrics exposition
 *    stays stable for scraping/alerting.
 *  - NO new runtime dependencies (no prom-client/StatsD/OpenTelemetry): the
 *    registry is an in-process typed counter/gauge store rendered to
 *    Prometheus text exposition format on scrape.
 *
 * WIRING STATUS (honest inventory — see metrics instrumentation sites):
 *  - Wired counters: AI_SIGNALS_RECEIVED, INTENTS_CREATED, INTENTS_REJECTED,
 *    INTENTS_EXPIRED, SIZING_FAILURES, ALLOCATION_FAILURES, RISK_APPROVALS,
 *    RISK_REJECTIONS, GRANTS_ISSUED, GRANTS_CONSUMED, DISPATCH_ATTEMPTS,
 *    DISPATCH_BLOCKS, PROVIDER_ACKNOWLEDGEMENTS, PROVIDER_REJECTS,
 *    AMBIGUOUS_PROVIDER_OUTCOMES, DUPLICATE_SUPPRESSIONS,
 *    CONFIRMATIONS_EXPIRED, ALLOCATIONS_RELEASED,
 *    EMERGENCY_CONTROL_ACTIVATIONS, KILL_SWITCH_FLATTENS,
 *    RECONCILIATION_CYCLES (trade-reconciliation.job — one increment per
 *      completed worker cycle, including the no-connections tick),
 *    RECONCILIATION_DISCREPANCIES (state-reconciliation.service — per-run
 *      DETECTED/NEW/AUTO_RESOLVED counts, brokerId label),
 *    PROTECTIVE_ORDER_REPAIRS (protective-order-reconciliation.service —
 *      REPAIRED/REPAIR_FAILED per connection sweep, brokerId label),
 *    BROKER_HEALTH_CHECKS (broker-health-check.job — per-provider check
 *      outcomes HEALTHY/UNHEALTHY/ERROR, brokerId label),
 *    BROKER_ENVIRONMENT_MISMATCHES (broker.service — BOTH declared-vs-
 *      observed detection sites: the assertConnectionEnvironment fence and
 *      the health-check inline suspension; brokerId + detection source
 *      labels. The orchestrator's dispatch-boundary fence counts its own
 *      ENVIRONMENT_MISMATCH under PROVIDER_ERRORS),
 *    OAUTH_TOKEN_REFRESHES (broker-oauth-token-lifecycle.service — the
 *      cTrader-family refresh outcome: SUCCESS / INVALID (fail-closed
 *      credential rejection) / LEASE_FAIL (bounded loser wait budget
 *      exhausted); brokerId label. Transient refresh errors (network/
 *      timeout) are intentionally NOT counted here — only terminal
 *      outcomes),
 *    PROVIDER_ERRORS (execution-orchestrator — typed BrokerAdapterError
 *      classification per provider on the dispatch path; brokerId + code
 *      labels. Read-path adapter errors surfaced by the health job count
 *      under BROKER_HEALTH_CHECKS instead),
 *    PROVIDER_RATE_LIMITS (execution-orchestrator — RATE_LIMITED-class
 *      typed provider errors on the dispatch path; brokerId label).
 *  - Wired gauges: see METRIC_GAUGE_NAMES (in-process last-value gauges set
 *    by the instrumented services + on-scrape DB-backed gauges computed by
 *    MetricsController).
 *  - Reserved (catalog-only, no honest counter site yet):
 *      GRANTS_EXPIRED — grants expire lazily via CAS (consumeGrantAtomic
 *        classifies EXPIRED); the Round 7 expiry sweeper only batch-expires
 *        PENDING confirmations (confirmations_expired), so there is no honest
 *        grants_expired increment site (audit-C A6 work item said "skip if
 *        awkward" — it is).
 *      LIVE_SESSIONS — session starts live in TradingService (out of the
 *        approved instrumentation file scope); the ACTIVE session count is
 *        served as the DB-backed gauge irexpro_live_sessions_active.
 */
export const METRIC_NAMES = {
  /** AI signals received (entry pipeline: outcome label; exit pipeline: kind label). */
  AI_SIGNALS_RECEIVED: 'ai_signals_received',
  /** Durable TradeIntents CREATED (new AI decisions normalized at intake). */
  INTENTS_CREATED: 'intents_created',
  /** Durable TradeIntents terminally REJECTED (definitive non-exposure). */
  INTENTS_REJECTED: 'intents_rejected',
  /** Stale CREATED TradeIntents expired by the execution-expiry sweeper. */
  INTENTS_EXPIRED: 'intents_expired',
  /** Position-sizing engine typed fail-closed rejections (code label). */
  SIZING_FAILURES: 'sizing_failures',
  /** Capital-allocation engine typed fail-closed rejections (code label). */
  ALLOCATION_FAILURES: 'allocation_failures',
  /** Risk Engine APPROVED decisions (durable grant issued). */
  RISK_APPROVALS: 'risk_approvals',
  /** Risk Engine REJECTED/SUSPENDED decisions (code label). */
  RISK_REJECTIONS: 'risk_rejections',
  /** Durable RiskGrants freshly ISSUED (idempotent reuse is not issuance). */
  GRANTS_ISSUED: 'grants_issued',
  /** Durable RiskGrants CONSUMED (single-winner CAS at the commitment). */
  GRANTS_CONSUMED: 'grants_consumed',
  /** (Reserved — see wiring status above.) */
  GRANTS_EXPIRED: 'grants_expired',
  /** Provider dispatch attempts entering the orchestrator critical section (operationClass label). */
  DISPATCH_ATTEMPTS: 'dispatch_attempts',
  /** Dispatches blocked BEFORE any provider call (gate label). */
  DISPATCH_BLOCKS: 'dispatch_blocks',
  /** Provider acknowledgements (outcome label: WORKING / FILLED). */
  PROVIDER_ACKNOWLEDGEMENTS: 'provider_acknowledgements',
  /** Provider-side typed order rejections. */
  PROVIDER_REJECTS: 'provider_rejects',
  /** Ambiguous/uncertain provider outcomes → RECONCILIATION_PENDING (source label). */
  AMBIGUOUS_PROVIDER_OUTCOMES: 'ambiguous_provider_outcomes',
  /** Reconciliation worker CYCLES (one increment per completed sweep tick).
   *  WIRED: trade-reconciliation.job.ts process(). */
  RECONCILIATION_CYCLES: 'reconciliation_cycles',
  /** Reconciliation discrepancies per completed run (outcome: DETECTED /
   *  NEW / AUTO_RESOLVED; brokerId label).
   *  WIRED: state-reconciliation.service.ts runForConnection(). */
  RECONCILIATION_DISCREPANCIES: 'reconciliation_discrepancies',
  /** Protective-order SL/TP verify-repair outcomes (outcome: REPAIRED /
   *  REPAIR_FAILED; brokerId label).
   *  WIRED: protective-order-reconciliation.service.ts reconcileProtectiveOrders(). */
  PROTECTIVE_ORDER_REPAIRS: 'protective_order_repairs',
  /** Broker connectivity probe outcomes from the 60s health job
   *  (outcome: HEALTHY / UNHEALTHY / ERROR; brokerId label).
   *  WIRED: broker-health-check.job.ts process(). */
  BROKER_HEALTH_CHECKS: 'broker_health_checks',
  /** Declared-vs-observed broker account environment mismatches detected
   *  at the fail-closed fences (brokerId + source labels).
   *  WIRED: broker.service.ts (assertConnectionEnvironment + healthCheck). */
  BROKER_ENVIRONMENT_MISMATCHES: 'broker_environment_mismatches',
  /** cTrader-family OAuth token refresh terminal outcomes (outcome: SUCCESS /
   *  INVALID / LEASE_FAIL; brokerId label).
   *  WIRED: broker-oauth-token-lifecycle.service.ts. */
  OAUTH_TOKEN_REFRESHES: 'oauth_token_refreshes',
  /** Typed provider adapter errors on the dispatch path (brokerId + code
   *  labels — the BrokerErrorCode classification).
   *  WIRED: execution-orchestrator.service.ts dispatch catch. */
  PROVIDER_ERRORS: 'provider_errors',
  /** RATE_LIMITED-class typed provider errors on the dispatch path
   *  (brokerId label).
   *  WIRED: execution-orchestrator.service.ts dispatch catch. */
  PROVIDER_RATE_LIMITS: 'provider_rate_limits',
  /** Exactly-once duplicate dispatch suppressions (clientOrderId idempotency). */
  DUPLICATE_SUPPRESSIONS: 'duplicate_suppressions',
  /** (Reserved — ACTIVE session count served as the live_sessions gauge.) */
  LIVE_SESSIONS: 'live_sessions',
  /** Emergency execution controls ACTIVATED (scope label). */
  EMERGENCY_CONTROL_ACTIVATIONS: 'emergency_control_activations',
  /** Kill-switch emergency flatten enqueues (activation only). */
  KILL_SWITCH_FLATTENS: 'kill_switch_flattens',
  /** Stale PENDING SEMI_AUTO confirmations expired by the sweeper. */
  CONFIRMATIONS_EXPIRED: 'confirmations_expired',
  /** Capital allocations released for expired intents (definite non-exposure). */
  ALLOCATIONS_RELEASED: 'allocations_released',
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

/**
 * DB-backed GAUGE names (computed on scrape by MetricsController; fail-open:
 * omitted from the exposition when the backing query fails).
 */
export const METRIC_GAUGE_NAMES = {
  /** Count of TradingSession rows with status ACTIVE. */
  LIVE_SESSIONS_ACTIVE: 'irexpro_live_sessions_active',
  /** Count of Trade rows OPEN / RECONCILIATION_PENDING, grouped by status label. */
  OPEN_TRADES: 'irexpro_open_trades',
  /** Epoch seconds of the last HEALTHY provider check per brokerId
   *  (set by the 60s broker health job; compute staleness as time() − value).
   *  WIRED: broker-health-check.job.ts (in-process, last-value). */
  BROKER_HEALTH_LAST_SUCCESS_EPOCH_SECONDS: 'irexpro_broker_health_last_success_epoch_seconds',
  /** Duration (seconds) of the most recent provider dispatch per brokerId
   *  (connect + state-changing provider call, retry/timeout wrapper included).
   *  WIRED: execution-orchestrator.service.ts (in-process, last-value). */
  PROVIDER_DISPATCH_DURATION_SECONDS: 'irexpro_provider_dispatch_duration_seconds',
  /** Count of users whose risk-profile kill switch is currently ACTIVE.
   *  WIRED: risk.service.ts toggleKillSwitch (counted at the only mutation
   *  site; in-process last-value — absent until the first toggle after a
   *  process restart). */
  KILL_SWITCHES_ACTIVE: 'irexpro_kill_switches_active',
  /** Count of BrokerConnection rows grouped by authorizationStatus label
   *  (live authorization state; every enum status materializes, 0 included).
   *  WIRED: metrics.controller.ts (on-scrape DB-backed, fail-open). */
  BROKER_CONNECTIONS_BY_AUTHORIZATION: 'irexpro_broker_connections',
  /** Seconds since the observation instant (providerObservedAt ??
   *  acceptedAt) of each connection's latest ACCEPTED snapshot, by generation
   *  (connectionId label — internal row id, never a provider account id).
   *  WIRED: metrics.controller.ts (on-scrape DB-backed, fail-open). */
  BROKER_SNAPSHOT_STALENESS_SECONDS: 'irexpro_broker_snapshot_staleness_seconds',
  /** Seconds since the most recent reconciliation run reached a terminal
   *  state (completed_at across reconciliation.runs — proves sweep LIVENESS,
   *  not per-connection success).
   *  WIRED: metrics.controller.ts (on-scrape DB-backed, fail-open; omitted
   *  when no run ever completed). */
  RECONCILIATION_LAST_CYCLE_AGE_SECONDS: 'irexpro_reconciliation_last_cycle_age_seconds',
  /** Count of Order rows stuck in RECONCILIATION_PENDING (dispatch outcome
   *  unproven — the orphaned/uncertain-order state; no confirmed provider
   *  truth). WIRED: metrics.controller.ts (on-scrape DB-backed, fail-open). */
  RECONCILIATION_PENDING_ORDERS: 'irexpro_reconciliation_pending_orders',
  /** Info-style gauge (value 1) carrying the AI engine's active model
   *  version + mode labels, refreshed from the EXISTING session-status read
   *  path (no per-scrape network calls — absent until the first status read
   *  after a process restart). WIRED: ai-engine-client.service.ts. */
  AI_MODEL_INFO: 'irexpro_ai_model_info',
} as const;

export type MetricGaugeName = (typeof METRIC_GAUGE_NAMES)[keyof typeof METRIC_GAUGE_NAMES];

/**
 * HELP strings for the Prometheus text exposition. Keys are metric names;
 * unknown names fall back to a generic sentence in the renderer.
 */
export const METRIC_HELP: Readonly<Record<string, string>> = {
  [METRIC_NAMES.AI_SIGNALS_RECEIVED]:
    'AI signals received by the strategy orchestrator (entry, outcome-labeled) and the exit orchestrator (kind=exit)',
  [METRIC_NAMES.INTENTS_CREATED]: 'Durable TradeIntents created at AI decision intake',
  [METRIC_NAMES.INTENTS_REJECTED]: 'Durable TradeIntents terminally rejected (risk decision)',
  [METRIC_NAMES.INTENTS_EXPIRED]:
    'Stale CREATED TradeIntents expired by the execution-expiry sweeper',
  [METRIC_NAMES.SIZING_FAILURES]: 'Typed fail-closed position-sizing rejections (code)',
  [METRIC_NAMES.ALLOCATION_FAILURES]: 'Typed fail-closed capital-allocation rejections (code)',
  [METRIC_NAMES.RISK_APPROVALS]: 'Risk Engine APPROVED decisions (durable grant issued)',
  [METRIC_NAMES.RISK_REJECTIONS]: 'Risk Engine REJECTED/SUSPENDED decisions (code)',
  [METRIC_NAMES.GRANTS_ISSUED]: 'Durable RiskGrants freshly issued',
  [METRIC_NAMES.GRANTS_CONSUMED]: 'Durable RiskGrants consumed at the dispatch commitment',
  [METRIC_NAMES.GRANTS_EXPIRED]: 'Reserved: RiskGrant expiries (lazy CAS expiry has no sweep site)',
  [METRIC_NAMES.DISPATCH_ATTEMPTS]:
    'Provider dispatch attempts entering the orchestrator critical section (operationClass)',
  [METRIC_NAMES.DISPATCH_BLOCKS]: 'Dispatches blocked before any provider call (gate)',
  [METRIC_NAMES.PROVIDER_ACKNOWLEDGEMENTS]: 'Provider order acknowledgements (outcome)',
  [METRIC_NAMES.PROVIDER_REJECTS]: 'Provider-side typed order rejections',
  [METRIC_NAMES.AMBIGUOUS_PROVIDER_OUTCOMES]:
    'Ambiguous provider outcomes moved to RECONCILIATION_PENDING (source)',
  [METRIC_NAMES.RECONCILIATION_CYCLES]: 'Completed reconciliation worker cycles (sweep ticks)',
  [METRIC_NAMES.RECONCILIATION_DISCREPANCIES]:
    'Reconciliation discrepancies per run (outcome: DETECTED, NEW, AUTO_RESOLVED)',
  [METRIC_NAMES.PROTECTIVE_ORDER_REPAIRS]:
    'Protective-order SL/TP verify-repair outcomes (outcome: REPAIRED, REPAIR_FAILED)',
  [METRIC_NAMES.BROKER_HEALTH_CHECKS]:
    'Broker connectivity probe outcomes from the periodic health job (outcome)',
  [METRIC_NAMES.BROKER_ENVIRONMENT_MISMATCHES]:
    'Declared-vs-observed broker environment mismatches (source-labeled)',
  [METRIC_NAMES.OAUTH_TOKEN_REFRESHES]:
    'cTrader-family OAuth token refresh terminal outcomes (outcome)',
  [METRIC_NAMES.PROVIDER_ERRORS]: 'Typed provider adapter errors on the dispatch path (code)',
  [METRIC_NAMES.PROVIDER_RATE_LIMITS]:
    'RATE_LIMITED-class typed provider errors on the dispatch path',
  [METRIC_NAMES.DUPLICATE_SUPPRESSIONS]: 'Exactly-once duplicate dispatch suppressions',
  [METRIC_NAMES.LIVE_SESSIONS]: 'Reserved: trading session starts (gauge carries the ACTIVE count)',
  [METRIC_NAMES.EMERGENCY_CONTROL_ACTIVATIONS]: 'Emergency execution controls activated (scope)',
  [METRIC_NAMES.KILL_SWITCH_FLATTENS]: 'Kill-switch emergency flatten enqueues (activation only)',
  [METRIC_NAMES.CONFIRMATIONS_EXPIRED]: 'Stale PENDING confirmations expired by the sweeper',
  [METRIC_NAMES.ALLOCATIONS_RELEASED]: 'Capital allocations released for expired intents',
  [METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE]: 'Trading sessions currently ACTIVE',
  [METRIC_GAUGE_NAMES.OPEN_TRADES]: 'Open trades by status (OPEN, RECONCILIATION_PENDING)',
  [METRIC_GAUGE_NAMES.BROKER_HEALTH_LAST_SUCCESS_EPOCH_SECONDS]:
    'Epoch seconds of the last healthy provider check per provider',
  [METRIC_GAUGE_NAMES.PROVIDER_DISPATCH_DURATION_SECONDS]:
    'Duration in seconds of the most recent provider dispatch per provider',
  [METRIC_GAUGE_NAMES.KILL_SWITCHES_ACTIVE]:
    'Users whose risk-profile kill switch is currently active',
  [METRIC_GAUGE_NAMES.BROKER_CONNECTIONS_BY_AUTHORIZATION]:
    'Broker connections by live authorization status',
  [METRIC_GAUGE_NAMES.BROKER_SNAPSHOT_STALENESS_SECONDS]:
    'Seconds since the latest accepted account snapshot observation per connection',
  [METRIC_GAUGE_NAMES.RECONCILIATION_LAST_CYCLE_AGE_SECONDS]:
    'Seconds since the most recent reconciliation run reached a terminal state',
  [METRIC_GAUGE_NAMES.RECONCILIATION_PENDING_ORDERS]:
    'Orders stuck in RECONCILIATION_PENDING (uncertain dispatch outcomes)',
  [METRIC_GAUGE_NAMES.AI_MODEL_INFO]:
    'Info gauge (value 1) carrying the AI engine active model version and mode labels',
};
