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
 *    EMERGENCY_CONTROL_ACTIVATIONS, KILL_SWITCH_FLATTENS.
 *  - Reserved (catalog-only, no in-scope counter site yet):
 *      GRANTS_EXPIRED — grants expire lazily via CAS (consumeGrantAtomic
 *        classifies EXPIRED); the Round 7 expiry sweeper only batch-expires
 *        PENDING confirmations (confirmations_expired), so there is no honest
 *        grants_expired increment site (audit-C A6 work item said "skip if
 *        awkward" — it is).
 *      LIVE_SESSIONS — session starts live in TradingService (out of the
 *        approved instrumentation file scope); the ACTIVE session count is
 *        served as the DB-backed gauge irexpro_live_sessions_active.
 *      RECONCILIATION_CYCLES / RECONCILIATION_DISCREPANCIES — the
 *        reconciliation sweep (trade-reconciliation.job.ts) is outside the
 *        approved instrumentation file scope; reserved for the next pass.
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
  /** (Reserved — see wiring status above.) */
  RECONCILIATION_CYCLES: 'reconciliation_cycles',
  /** (Reserved — see wiring status above.) */
  RECONCILIATION_DISCREPANCIES: 'reconciliation_discrepancies',
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
  [METRIC_NAMES.RECONCILIATION_CYCLES]: 'Reserved: reconciliation sweep cycles',
  [METRIC_NAMES.RECONCILIATION_DISCREPANCIES]: 'Reserved: reconciliation discrepancies found',
  [METRIC_NAMES.DUPLICATE_SUPPRESSIONS]: 'Exactly-once duplicate dispatch suppressions',
  [METRIC_NAMES.LIVE_SESSIONS]: 'Reserved: trading session starts (gauge carries the ACTIVE count)',
  [METRIC_NAMES.EMERGENCY_CONTROL_ACTIVATIONS]: 'Emergency execution controls activated (scope)',
  [METRIC_NAMES.KILL_SWITCH_FLATTENS]: 'Kill-switch emergency flatten enqueues (activation only)',
  [METRIC_NAMES.CONFIRMATIONS_EXPIRED]: 'Stale PENDING confirmations expired by the sweeper',
  [METRIC_NAMES.ALLOCATIONS_RELEASED]: 'Capital allocations released for expired intents',
  [METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE]: 'Trading sessions currently ACTIVE',
  [METRIC_GAUGE_NAMES.OPEN_TRADES]: 'Open trades by status (OPEN, RECONCILIATION_PENDING)',
};
