'use strict';
/**
 * V2 engine component map — phase 2 (P1-0.5).
 *
 * Machine-readable mirror of
 * docs/research/AI_ENGINE_V2_COMPONENT_MAP_PHASE2_20261127.md.
 * Covers the three areas map v1 (v2-engine-component-map.cjs, 64 components)
 * named but did not itemize: the Python ML core, the orchestration
 * scan-cycle internals, and the cross-layer data-flow edges.
 *
 * Research-only: no runtime import, no DB, no broker access,
 * executionAuthority NONE. On every CI run the detectors re-prove that
 * (a) each mapped file still exists at the recorded location,
 * (b) the Python training-domain inventory reconciles with the directory,
 * (c) the orchestration runOnce span stays a single >=3000-line method,
 * (d) the TS->Python engine-client edge endpoints are still pinned,
 * (e) the evidence SQL edge tables are still pinned,
 * and that tampering with the inventory is a typed refusal.
 * Content anchors are verified, never bare line numbers.
 */
const fs = require('node:fs');
const path = require('node:path');

const ARTIFACT = 'v2-engine-component-map-phase2-v1';
const TOTAL_COMPONENTS = 47;

const ALLOWED_LAYERS = [
  'py-entry', 'py-api', 'py-models', 'py-signals', 'py-scheduler',
  'py-agents', 'py-backtesting', 'py-market-data',
  'orchestration', 'data-edge',
];

const ALLOWED_FAMILIES = [
  'python-app', 'python-api', 'python-models', 'python-signals',
  'python-scheduler', 'python-agents', 'python-backtesting',
  'python-market-data', 'orchestration', 'data-edge',
];

const PHASE2_CLAIMED_COUNTS = {
  'python-app': 1,
  'python-api': 6,
  'python-models': 8,
  'python-signals': 4,
  'python-scheduler': 1,
  'python-agents': 8,
  'python-backtesting': 6,
  'python-market-data': 6,
  orchestration: 5,
  'data-edge': 2,
};

const DECLARED_TRAINING_INVENTORY = {
  pyTotal: 73,
  testSuites: 6,
  readonlySql: 7,
  nonTestPy: 67,
};

const RUNONCE_MIN_SPAN_LINES = 3000;

const ENGINE_CLIENT_BASE_URL_DEFAULT = 'http://localhost:8001/api/v1';
const ENGINE_CLIENT_ENDPOINTS = [
  '/models/active',
  '/models/challengers/plan-b-v4/status',
  '/models/challengers/plan-b-v4/score-broker',
  '/models/challengers/plan-b-v85/status',
  '/models/challengers/plan-b-v85/score-broker-checkpoint',
];

const EVIDENCE_TABLES = [
  'trading.trading_sessions',
  'trading.m1_tactical_decisions',
  'trading.trades',
  'trading.capital_allocations',
];

const c = (kind, value, tolerance = 0) => ({ kind, value, tolerance });

const component = (key, layer, family, filePath, artifact, constants, notes) =>
  ({ key, layer, family, path: filePath, artifact, constants, notes });

const PYTHON = 'services/ai-engine/app';
const TS = 'apps/api/src/modules';

const PHASE2_COMPONENTS = [
  // python-app (1)
  component('py-app-main', 'py-entry', 'python-app', `${PYTHON}/main.py`,
    'create_app (FastAPI)', [c('fileLines', 111, 1)],
    'FastAPI factory at l.79; six routers mounted l.101-106 (health, signals, market_data, models, scheduler, backtests); module-level app = create_app() l.111.'),
  // python-api (6)
  component('py-api-health', 'py-api', 'python-api', `${PYTHON}/api/v1/routes/health.py`,
    'health router', [c('fileLines', 35, 1)], 'Liveness/readiness surface.'),
  component('py-api-signals', 'py-api', 'python-api', `${PYTHON}/api/v1/routes/signals.py`,
    'signals router', [c('fileLines', 116, 1)], 'Signal generation entry consumed by collectors.'),
  component('py-api-market-data', 'py-api', 'python-api', `${PYTHON}/api/v1/routes/market_data.py`,
    'market data router', [c('fileLines', 28, 1)], 'OHLCV passthrough; not on the DEMO/LIVE decision path.'),
  component('py-api-models', 'py-api', 'python-api', `${PYTHON}/api/v1/routes/models.py`,
    'models router', [c('fileLines', 453, 1)],
    'The only Python surface the TS runtime calls (edge E1): /models/active and the two challenger score endpoints.'),
  component('py-api-scheduler', 'py-api', 'python-api', `${PYTHON}/api/v1/routes/scheduler.py`,
    'scheduler router', [c('fileLines', 198, 1)], 'Session start/stop surface.'),
  component('py-api-backtests', 'py-api', 'python-api', `${PYTHON}/api/v1/routes/backtests.py`,
    'backtests router', [c('fileLines', 97, 1)], 'Offline backtest trigger.'),
  // python-models (8)
  component('py-model-baseline-xgboost', 'py-models', 'python-models', `${PYTHON}/domain/models/baseline_xgboost.py`,
    'BaselineXGBoostModel', [c('fileLines', 897, 1)],
    'Active Champion-shaped model; duplicated regime-threshold block l.540-549 (audit A5).'),
  component('py-model-high-conviction-challenger', 'py-models', 'python-models', `${PYTHON}/domain/models/high_conviction_challenger.py`,
    'PlanBV4HighConvictionChallenger', [c('fileLines', 345, 1)],
    'Shadow challenger Plan-B V4; scored via /models/challengers/plan-b-v4/score-broker.'),
  component('py-model-post-entry-protection-challenger', 'py-models', 'python-models', `${PYTHON}/domain/models/post_entry_protection_challenger.py`,
    'PlanBV85PostEntryProtectionChallenger', [c('fileLines', 209, 1)],
    'Shadow challenger Plan-B V85; scored via /models/challengers/plan-b-v85/score-broker-checkpoint.'),
  component('py-model-multitimeframe-features', 'py-models', 'python-models', `${PYTHON}/domain/models/multitimeframe_features.py`,
    'multitimeframe_feature_columns', [c('fileLines', 344, 1)],
    'The 128-column MTF feature contract, verified by execution in map v1.'),
  component('py-model-registry', 'py-models', 'python-models', `${PYTHON}/domain/models/registry.py`,
    'ModelRegistry', [c('fileLines', 108, 1)],
    'class at l.24; register_model l.32 requires a governance record; build_default_registry l.90 registers an explicit heuristic scaffold for dev paper mode when no verified artifact is configured.'),
  component('py-model-governance', 'py-models', 'python-models', `${PYTHON}/domain/models/governance.py`,
    'ModelGovernanceMetadata', [c('fileLines', 78, 1)], 'Governance record type required at registration.'),
  component('py-model-feature-engineering', 'py-models', 'python-models', `${PYTHON}/domain/models/feature_engineering.py`,
    'feature transforms', [c('fileLines', 187, 1)], 'Shared trainer-side transforms.'),
  component('py-model-schemas', 'py-models', 'python-models', `${PYTHON}/domain/models/schemas.py`,
    'model wire schemas', [c('fileLines', 46, 1)], 'Payload schemas.'),
  // python-signals (4)
  component('py-signal-generator', 'py-signals', 'python-signals', `${PYTHON}/domain/signals/signal_generator.py`,
    'SignalGenerator', [c('fileLines', 420, 1)], 'Composes model output into AiSignalCandidate-shaped signals.'),
  component('py-signal-confidence', 'py-signals', 'python-signals', `${PYTHON}/domain/signals/confidence.py`,
    'confidence helpers', [c('fileLines', 14, 1)],
    'Thin; the heavy confidence transforms live on the TS side (audit B1).'),
  component('py-signal-explainability', 'py-signals', 'python-signals', `${PYTHON}/domain/signals/explainability.py`,
    'explainability helpers', [c('fileLines', 31, 1)], 'Reason-code assembly.'),
  component('py-signal-schemas', 'py-signals', 'python-signals', `${PYTHON}/domain/signals/schemas.py`,
    'signal wire schemas', [c('fileLines', 112, 1)], 'Signal payload schemas.'),
  // python-scheduler (1)
  component('py-scheduler-signal-scheduler', 'py-scheduler', 'python-scheduler', `${PYTHON}/domain/scheduler/signal_scheduler.py`,
    'SignalScheduler', [c('fileLines', 482, 1)],
    'PendingHorizonExit l.35; ScheduledSessionJob l.46; class l.86; register_session l.122; _run_session_job l.240. Python side schedules per registered session; the authoritative DEMO/LIVE cycle is the TS M1TacticalSchedulerService.'),
  // python-agents (8)
  component('py-agents-coordinator', 'py-agents', 'python-agents', `${PYTHON}/domain/agents/coordinator.py`,
    'agent coordinator', [c('fileLines', 121, 1)], 'Context/agent assembly.'),
  component('py-agents-context-service', 'py-agents', 'python-agents', `${PYTHON}/domain/agents/context_service.py`,
    'context service', [c('fileLines', 156, 1)], 'Context assembly service.'),
  component('py-agents-context-sources', 'py-agents', 'python-agents', `${PYTHON}/domain/agents/context_sources.py`,
    'context sources', [c('fileLines', 199, 1)], 'Context source registry.'),
  component('py-agents-macro-context', 'py-agents', 'python-agents', `${PYTHON}/domain/agents/macro_context.py`,
    'macro context', [c('fileLines', 294, 1)], 'Macro context builder.'),
  component('py-agents-snapshot', 'py-agents', 'python-agents', `${PYTHON}/domain/agents/snapshot.py`,
    'context snapshot', [c('fileLines', 105, 1)], 'Snapshot type.'),
  component('py-agents-schemas', 'py-agents', 'python-agents', `${PYTHON}/domain/agents/schemas.py`,
    'agent schemas', [c('fileLines', 130, 1)], 'Agent payload schemas.'),
  component('py-agents-bls-calendar', 'py-agents', 'python-agents', `${PYTHON}/domain/agents/providers/bls_calendar.py`,
    'BLS calendar provider', [c('fileLines', 285, 1)], 'Research/data surface, not an execution input.'),
  component('py-agents-bls-historical-schedule', 'py-agents', 'python-agents', `${PYTHON}/domain/agents/providers/bls_historical_schedule.py`,
    'BLS historical schedule provider', [c('fileLines', 360, 1)], 'Historical schedule archive provider.'),
  // python-backtesting (6)
  component('py-backtest-engine', 'py-backtesting', 'python-backtesting', `${PYTHON}/domain/backtesting/backtest_engine.py`,
    'BacktestEngine', [c('fileLines', 167, 1)], 'Offline engine; not connected to the DEMO/LIVE decision path.'),
  component('py-backtest-trade-simulator', 'py-backtesting', 'python-backtesting', `${PYTHON}/domain/backtesting/trade_simulator.py`,
    'TradeSimulator', [c('fileLines', 209, 1)], 'Synthetic fill simulation.'),
  component('py-backtest-metrics', 'py-backtesting', 'python-backtesting', `${PYTHON}/domain/backtesting/metrics.py`,
    'backtest metrics', [c('fileLines', 111, 1)], 'Metric computation.'),
  component('py-backtest-report-builder', 'py-backtesting', 'python-backtesting', `${PYTHON}/domain/backtesting/report_builder.py`,
    'report builder', [c('fileLines', 64, 1)], 'Report assembly.'),
  component('py-backtest-validation', 'py-backtesting', 'python-backtesting', `${PYTHON}/domain/backtesting/validation.py`,
    'backtest validation', [c('fileLines', 53, 1)], 'Input validation.'),
  component('py-backtest-schemas', 'py-backtesting', 'python-backtesting', `${PYTHON}/domain/backtesting/schemas.py`,
    'backtest schemas', [c('fileLines', 152, 1)], 'Backtest payload schemas.'),
  // python-market-data (6)
  component('py-md-ohlcv-service', 'py-market-data', 'python-market-data', `${PYTHON}/domain/market_data/ohlcv_service.py`,
    'OHLCV service', [c('fileLines', 238, 1)], 'Python-side OHLCV; authoritative store is the TS provider-quote-candle-store (map v1 §8).'),
  component('py-md-redis-cache', 'py-market-data', 'python-market-data', `${PYTHON}/domain/market_data/redis_cache.py`,
    'redis cache', [c('fileLines', 103, 1)], 'Market data cache.'),
  component('py-md-schemas', 'py-market-data', 'python-market-data', `${PYTHON}/domain/market_data/schemas.py`,
    'market data schemas', [c('fileLines', 49, 1)], 'Payload schemas.'),
  component('py-md-provider-base', 'py-market-data', 'python-market-data', `${PYTHON}/domain/market_data/providers/base.py`,
    'provider base', [c('fileLines', 36, 1)], 'Provider interface.'),
  component('py-md-provider-broker', 'py-market-data', 'python-market-data', `${PYTHON}/domain/market_data/providers/broker_provider.py`,
    'broker provider', [c('fileLines', 224, 1)], 'Broker-native OHLCV provider.'),
  component('py-md-provider-mock', 'py-market-data', 'python-market-data', `${PYTHON}/domain/market_data/providers/mock_provider.py`,
    'mock provider', [c('fileLines', 118, 1)], 'Deterministic test provider.'),
  // orchestration (5)
  component('ts-orch-m1-tactical-scheduler', 'orchestration', 'orchestration', `${TS}/ai/m1-tactical-scheduler.service.ts`,
    'M1TacticalSchedulerService', [c('fileLines', 4871, 1)],
    'class l.789; runOnce l.959 -> observeOpenPositionRescueShadow l.4652: the whole scan->decide->dispatch cycle is ONE method of ~3,693 lines; the detector asserts the span stays >= 3000.'),
  component('ts-orch-strategy-orchestrator', 'orchestration', 'orchestration', `${TS}/strategy/strategy-orchestrator.service.ts`,
    'StrategyOrchestratorService', [c('fileLines', 1536, 1)],
    'processSignal l.181; recordTradeIntent l.1216; validateStructure l.1448; recordIgnored l.1463.'),
  component('ts-orch-vps-signal-collector', 'orchestration', 'orchestration', `${TS}/ai/vps-forex-signal-collector.service.ts`,
    'VpsForexSignalCollectorService', [c('fileLines', 7283, 1)],
    'class l.1045; maybeCollect l.1526; collectOnce l.1587; upstream ingest cadence.'),
  component('ts-orch-m1-tactical-evidence', 'orchestration', 'orchestration', `${TS}/ai/m1-tactical-evidence.service.ts`,
    'M1TacticalEvidenceService', [c('fileLines', 3013, 1)],
    'Cohort SQL over trading.trading_sessions / trading.m1_tactical_decisions (route, execution_authority, outcome_state) l.479-616; settled join trading.trades l.664 with sizing from trading.capital_allocations l.677.'),
  component('ts-orch-ai-engine-client', 'orchestration', 'orchestration', `${TS}/ai-engine-client/ai-engine-client.service.ts`,
    'AiEngineClientService', [c('fileLines', 370, 1)],
    'Default base URL http://localhost:8001/api/v1 (l.152); exactly five endpoints called (l.220-269); see data-edge E1.'),
  // data-edge (2)
  component('edge-e1-engine-client', 'data-edge', 'data-edge', `${TS}/ai-engine-client/ai-engine-client.service.ts`,
    'E1 TS->Python score edge', [
      c('endpoints', ENGINE_CLIENT_ENDPOINTS.length),
      c('baseUrlDefault', 1),
    ],
    'Content anchors: base URL default + GET /models/active, GET/POST plan-b-v4 status/score-broker, GET/POST plan-b-v85 status/score-broker-checkpoint. Nothing else in the Python API is on the DEMO/LIVE decision path.'),
  component('edge-e2-evidence-tables', 'data-edge', 'data-edge', `${TS}/ai/m1-tactical-evidence.service.ts`,
    'E2 evidence persistence edge', [c('tables', EVIDENCE_TABLES.length)],
    'Content anchors: trading.trading_sessions, trading.m1_tactical_decisions (route, execution_authority, outcome_state), trading.trades, trading.capital_allocations. Canonical decision/evidence store the V2 attribution ledger stays disjoint from.'),
];

const ENGINE_COMPONENT_MAP_PHASE2 = {
  meta: { artifact: ARTIFACT, totalComponents: TOTAL_COMPONENTS },
  components: PHASE2_COMPONENTS,
};

const refusal = (code, detail) => ({ ok: false, refusal: { code, detail } });
const pass = (detail) => ({ ok: true, detail });

function validatePhase2ComponentMap(map) {
  if (!map || !Array.isArray(map.components)) return false;
  const seen = new Set();
  for (const entry of map.components) {
    if (!entry || typeof entry !== 'object') return false;
    for (const field of ['key', 'layer', 'family', 'path', 'artifact', 'notes']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) return false;
    }
    if (!ALLOWED_LAYERS.includes(entry.layer)) return false;
    if (!ALLOWED_FAMILIES.includes(entry.family)) return false;
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    if (!Array.isArray(entry.constants)) return false;
    for (const constant of entry.constants) {
      if (!constant || typeof constant.kind !== 'string' || constant.kind.length === 0) return false;
      if (typeof constant.value !== 'number' || !Number.isFinite(constant.value)) return false;
      if (constant.tolerance !== undefined
        && (typeof constant.tolerance !== 'number' || !Number.isFinite(constant.tolerance))) return false;
    }
  }
  return true;
}

function verifyPhase2ComponentPaths(repoRoot, map = ENGINE_COMPONENT_MAP_PHASE2) {
  for (const entry of map.components) {
    const absolute = path.join(repoRoot, entry.path);
    if (!fs.existsSync(absolute)) {
      return refusal('PHASE2_COMPONENT_PATH_MISSING', entry.path);
    }
  }
  return pass(`${map.components.length} mapped paths exist`);
}

function verifyPythonTrainingInventory(repoRoot, declared = DECLARED_TRAINING_INVENTORY) {
  const dir = path.join(repoRoot, 'services/ai-engine/app/domain/training');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return refusal('PHASE2_TRAINING_INVENTORY_MISMATCH', `training directory unreadable: ${error.message}`);
  }
  const py = names.filter((n) => n.endsWith('.py'));
  const sql = names.filter((n) => n.endsWith('.sql'));
  const tests = py.filter((n) => n.startsWith('test_'));
  const nonTestPy = py.length - tests.length;
  const actual = { pyTotal: py.length, testSuites: tests.length, readonlySql: sql.length, nonTestPy };
  for (const key of Object.keys(declared)) {
    if (actual[key] !== declared[key]) {
      return refusal('PHASE2_TRAINING_INVENTORY_MISMATCH',
        `${key}: declared ${declared[key]}, found ${actual[key]}`);
    }
  }
  return pass(`training inventory reconciles: ${JSON.stringify(actual)}`);
}

/** Pure helper: line span of the runOnce method body in the scheduler source. */
function computeRunOnceSpan(source) {
  const start = source.indexOf('async runOnce(');
  const next = source.indexOf('async observeOpenPositionRescueShadow(');
  if (start === -1 || next === -1 || next <= start) return { start, end: next, span: 0 };
  const startLine = source.slice(0, start).split('\n').length;
  const endLine = source.slice(0, next).split('\n').length;
  return { start: startLine, end: endLine, span: endLine - startLine };
}

function verifyOrchestrationAnchors(repoRoot) {
  const file = path.join(repoRoot, 'apps/api/src/modules/ai/m1-tactical-scheduler.service.ts');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return refusal('PHASE2_RUNONCE_SPAN_REGRESSION', `scheduler unreadable: ${error.message}`);
  }
  if (!source.includes('export class M1TacticalSchedulerService')) {
    return refusal('PHASE2_RUNONCE_SPAN_REGRESSION', 'scheduler class anchor missing');
  }
  const span = computeRunOnceSpan(source);
  if (span.span < RUNONCE_MIN_SPAN_LINES) {
    return refusal('PHASE2_RUNONCE_SPAN_REGRESSION',
      `runOnce span ${span.span} < ${RUNONCE_MIN_SPAN_LINES} — P1-3 extraction-seam inputs are stale`);
  }
  return pass(`runOnce span = ${span.span} lines (l.${span.start} -> l.${span.end})`);
}

function verifyEngineClientEdge(repoRoot) {
  const file = path.join(repoRoot, 'apps/api/src/modules/ai-engine-client/ai-engine-client.service.ts');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return refusal('PHASE2_ENGINE_CLIENT_EDGE_DRIFT', `client unreadable: ${error.message}`);
  }
  if (!source.includes(ENGINE_CLIENT_BASE_URL_DEFAULT)) {
    return refusal('PHASE2_ENGINE_CLIENT_EDGE_DRIFT',
      `base URL default ${ENGINE_CLIENT_BASE_URL_DEFAULT} missing`);
  }
  for (const endpoint of ENGINE_CLIENT_ENDPOINTS) {
    if (!source.includes(endpoint)) {
      return refusal('PHASE2_ENGINE_CLIENT_EDGE_DRIFT', `endpoint ${endpoint} missing`);
    }
  }
  return pass(`engine-client edge pinned: base URL + ${ENGINE_CLIENT_ENDPOINTS.length} endpoints`);
}

function verifyEvidenceEdge(repoRoot) {
  const file = path.join(repoRoot, 'apps/api/src/modules/ai/m1-tactical-evidence.service.ts');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return refusal('PHASE2_EVIDENCE_EDGE_DRIFT', `evidence service unreadable: ${error.message}`);
  }
  for (const table of EVIDENCE_TABLES) {
    if (!source.includes(table)) {
      return refusal('PHASE2_EVIDENCE_EDGE_DRIFT', `table ${table} missing`);
    }
  }
  return pass(`evidence edge pinned: ${EVIDENCE_TABLES.length} tables`);
}

function countByFamily(components) {
  const byFamily = {};
  for (const entry of components) {
    byFamily[entry.family] = (byFamily[entry.family] || 0) + 1;
  }
  return byFamily;
}

function summarizePhase2Map(map = ENGINE_COMPONENT_MAP_PHASE2) {
  const byFamily = countByFamily(map.components);
  const byLayer = {};
  for (const entry of map.components) {
    byLayer[entry.layer] = (byLayer[entry.layer] || 0) + 1;
  }
  const reconciliation = Object.entries(PHASE2_CLAIMED_COUNTS).map(([family, claimed]) => ({
    family,
    claimed,
    mapped: byFamily[family] || 0,
    reconciled: (byFamily[family] || 0) === claimed,
  }));
  return {
    artifact: ARTIFACT,
    totalComponents: map.components.length,
    byFamily,
    byLayer,
    reconciliation,
  };
}

module.exports = {
  ENGINE_COMPONENT_MAP_PHASE2,
  PHASE2_CLAIMED_COUNTS,
  ALLOWED_LAYERS,
  ALLOWED_FAMILIES,
  DECLARED_TRAINING_INVENTORY,
  RUNONCE_MIN_SPAN_LINES,
  ENGINE_CLIENT_BASE_URL_DEFAULT,
  ENGINE_CLIENT_ENDPOINTS,
  EVIDENCE_TABLES,
  validatePhase2ComponentMap,
  verifyPhase2ComponentPaths,
  verifyPythonTrainingInventory,
  computeRunOnceSpan,
  verifyOrchestrationAnchors,
  verifyEngineClientEdge,
  verifyEvidenceEdge,
  summarizePhase2Map,
};
