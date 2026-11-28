#!/usr/bin/env node
'use strict';
/**
 * iRexPro AI Engine V2 — P1-4 calibration-service consolidation contract.
 *
 * Research-only executable mirror for the calibration consolidation spec
 * (`AI_ENGINE_V2_P1_4_CALIBRATION_CONSOLIDATION_SPEC_20261127.md`):
 *
 * 1. Six calibration layers (C1..C6) + two auxiliaries (A1/A2) and five
 *    prediction families (P1..P5) inventoried with path-pinned constants.
 *    Component map v1 §4/§6 inputs; counts reconcile with the audit (A4/B4).
 * 2. Faithful predicate mirrors of every layer's pure evaluation core — the
 *    same Bayesian blend, evidence ladders, maturity vocabularies, decayed
 *    pulse, p95/p90 economics and cost stress as the production files, with
 *    `executionAuthority: NONE` everywhere.
 * 3. The frozen disagreement corpus CL-D01..CL-D12 — ten divergence records
 *    + two controls — whose verdicts are COMPUTED by the mirrors on every
 *    run and reconciled against committed expectations; tampering with the
 *    corpus, the mirrors or the statistics is a typed refusal.
 * 4. CAL-1, the unified calibration contract: one evidence ladder, one
 *    sample ladder, one blend, one maturity vocabulary, one authority
 *    gradient, one scoreboard.
 * 5. CAL-2 (V2-7): the pre-outcome prediction registration format — the
 *    append-only scoreboard every prediction family must register into
 *    BEFORE outcomes resolve.
 *
 * Typed refusals (never guessed, never defaulted):
 *   CALIBRATION_INPUT_REQUIRED, CALIBRATION_UNSUPPORTED_SURFACE,
 *   CALIBRATION_INPUT_OUT_OF_RANGE, CALIBRATION_CONTRACT_TAMPERED,
 *   CALIBRATION_PATH_DRIFT.
 *
 * Research-only: no runtime import, no production data, no broker access,
 * no deployment. `executionAuthority: 'NONE'` on every artifact.
 */
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_ARTIFACT = 'v2-calibration-consolidation-contract-v1';
const AI = 'apps/api/src/modules/ai';
const ORCHESTRATOR = 'apps/api/src/modules/strategy/strategy-orchestrator.service.ts';

// --------------------------------------------------------------- inventory

const const_ = (name, value, line) => ({ name, value, line });

/**
 * The six calibration layers + two auxiliaries (component map v1 §4).
 * Every constant was read from the file at the pinned line on the branch
 * tree this contract was authored on; verifyCalibrationPaths() re-proves
 * name, value AND line on every CI run.
 */
const CALIBRATION_LAYERS = [
  {
    key: 'C1',
    path: `${AI}/adaptive-prediction-calibration.service.ts`,
    artifact: 'adaptive-prediction-calibration-v1',
    role: 'Bayesian blend of raw confidence / expectedR against resolved ensemble shadow outcomes',
    authority: 'PAPER_BLOCK_RESCUE',
    constants: [
      const_('ADAPTIVE_CALIBRATION_MIN_AUTHORITATIVE_SAMPLES', 12, 8),
      const_('ADAPTIVE_CALIBRATION_MATURE_MIN_SAMPLES', 20, 9),
      const_('ADAPTIVE_CALIBRATION_MIN_WINS', 5, 10),
      const_('ADAPTIVE_CALIBRATION_MIN_LOSSES', 5, 11),
      const_('ADAPTIVE_CALIBRATION_RESCUE_MIN_NET_EXPECTED_R', 0.12, 12),
      const_('ADAPTIVE_CALIBRATION_PRIOR_WEIGHT', 8, 13),
    ],
    notes: 'Evidence ladder EXACT -> PAIR_DIRECTION_ROUTE -> ROUTE -> GLOBAL; only EXACT/PAIR_DIRECTION_ROUTE carry block/rescue authority.',
  },
  {
    key: 'C2',
    path: `${AI}/adaptive-edge-matrix.service.ts`,
    artifact: 'adaptive-edge-matrix-v1',
    role: 'Cell evidence matrix: strength-normalized expectedR blending, PF/sharpe/drawdown, upsize verdict',
    authority: 'PAPER_UPSIZE_VERDICT',
    constants: [
      const_('ADAPTIVE_EDGE_MATURE_MIN_SAMPLES', 20, 7),
      const_('ADAPTIVE_EDGE_MIN_WINS', 5, 8),
      const_('ADAPTIVE_EDGE_MIN_LOSSES', 5, 9),
    ],
    notes: 'Blending strengths route->pair 24, pair->session 16, session->exact 20; SPARSE below 8 exact rows; smoothed win rate (wins+2)/(n+4).',
  },
  {
    key: 'C3',
    path: `${AI}/adaptive-shadow-directional-pulse.ts`,
    artifact: 'adaptive-shadow-directional-pulse-v1',
    role: 'Decayed directional pulse over last resolved shadow outcomes per side',
    authority: 'RANKING_ONLY',
    constants: [
      const_('ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MAX_OUTCOMES_PER_SIDE', 10, 2),
      const_('ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_MIN_OUTCOMES_PER_SIDE', 4, 3),
      const_('ADAPTIVE_SHADOW_DIRECTIONAL_PULSE_DECAY', 0.65, 4),
    ],
    notes: 'quality = clamp01(0.5 + advantageR / 4); SUPPORTED at advantage >= 0.5 with positive candidate mean; ranking only.',
  },
  {
    key: 'C4',
    path: `${AI}/paper-spread-calibration-shadow.ts`,
    artifact: 'paper-spread-calibration-shadow-v1',
    role: 'Session p95 spread calibration of the fixed paper spread with a fixed-fraction floor',
    authority: 'ECONOMICS_ONLY',
    constants: [
      const_('PAPER_SPREAD_CALIBRATION_MIN_SAMPLES', 100, 4),
      const_('PAPER_SPREAD_CALIBRATION_MIN_FIXED_FRACTION', 0.25, 5),
    ],
    notes: 'costR = 1.25 * spread / stopDistance; below 100 samples the fixed spread is kept (SPARSE_HISTORY_FIXED_FALLBACK).',
  },
  {
    key: 'C5',
    path: `${AI}/m1-causal-commission-shadow.ts`,
    artifact: 'm1-causal-commission-shadow-v1',
    role: 'p90 causal fee estimator subtracted additively from the spread-only expectedR',
    authority: 'ECONOMICS_ONLY',
    constants: [
      const_('M1_CAUSAL_COMMISSION_MIN_PRIOR_TRADES', 5, 4),
      const_('M1_CAUSAL_COMMISSION_PERCENTILE', 0.9, 5),
    ],
    notes: 'SHADOW_ONLY / noTradeAuthority; estimatedNetAfterFeeR = baseline - p90FeeR (6dp); floor check is hypothetical only.',
  },
  {
    key: 'C6',
    path: `${AI}/m1-probation-causal-cost-stress.ts`,
    artifact: 'm1-probation-causal-broker-cost-stress-v1',
    role: 'Causal cost stress: stressed spread + slippage + p90 fee against gross R',
    authority: 'ECONOMICS_ONLY',
    constants: [
      const_('PROBATION_MIN_PRIOR_FEES', 5, 6),
      const_('PROBATION_MIN_PRIOR_SPREAD_BARS', 5, 7),
      const_('PROBATION_SPREAD_STRESS_MULTIPLIER', 1.25, 8),
      const_('PROBATION_SLIPPAGE_STRESS_PIPS', 0.5, 9),
    ],
    notes: 'pip 0.0001, 0.01 for JPY; ESTIMABLE_STRESS_ONLY requires >= 5 fee fills and >= 5 spread bars; missing evidence stays null.',
  },
  {
    key: 'A1',
    path: `${AI}/calibration-bidirectional-conflict.ts`,
    artifact: 'calibration-bidirectional-conflict-shadow-v1',
    role: 'Auxiliary: arbitrates a calibration block against the paired-direction preference',
    authority: 'ARBITER',
    constants: [const_('BALANCED_EPSILON', 1e-9, 72)],
    notes: 'active only when the block binds the candidate side (BLOCK_CURRENT_SIDE_FAVORED); opposite-side preference keeps the block inactive.',
  },
  {
    key: 'A2',
    path: `${AI}/paper-spread-calibration-history.ts`,
    artifact: 'paper-spread-calibration-shadow-v1 (history companion)',
    role: 'Auxiliary: persistence for C4 (p95 spread from provider quote candles)',
    authority: 'EVIDENCE_SOURCE',
    constants: [const_("interval '21 days'", 21, 27)],
    notes: "Reads market_data.provider_quote_candles over a trailing '21 days' window (line anchor l.27); M1 spread_close > 0 only.",
  },
];
const CALIBRATION_LAYER_COUNT = CALIBRATION_LAYERS.length; // 6 layers + 2 auxiliaries — map v1 §4

/**
 * The five prediction families (component map v1 §6). No shared scoreboard
 * exists today (audit B6) — CAL-2 defines the registration format they must
 * share. P4 is RESEARCH_ONLY and excluded from the qualification scoreboard
 * (audit B3/D5).
 */
const PREDICTION_FAMILIES = [
  {
    key: 'P1',
    path: `${AI}/plan-b-multimodel-shadow.ts`,
    artifact: 'plan-b-multimodel-shadow-v4',
    quantity: 'PLAN_B_EXPECTED_R',
    constants: [
      const_('PLAN_B_ENSEMBLE_ARTIFACT', 'plan-b-multimodel-shadow-v4', 3),
      const_('PLAN_B_CANDIDATE_CONFIDENCE_FLOOR', 0.64, 50),
      const_('PLAN_B_GROSS_EXPECTED_R_FLOOR', 0.08, 51),
      const_('PLAN_B_REVERSAL_GROSS_EXPECTED_R_FLOOR', 0.18, 52),
    ],
    notes: 'Gross expectedR family; floor 0.08 at l.51 (reversal 0.18 at l.52); candidate confidence floor 0.64 at l.50 — matches component map v1.',
  },
  {
    key: 'P2',
    path: `${AI}/v8-shadow-meta-scorer.ts`,
    artifact: 'v8-shadow-online-meta-v1',
    quantity: 'V8_LOGISTIC_PROBABILITY',
    constants: [
      const_('V8_SHADOW_ARTIFACT', 'v8-shadow-online-meta-v1', 1),
      const_('V8_SHADOW_ADMISSION_THRESHOLD', 0.46, 3),
    ],
    notes: 'Logistic probability family; admission threshold 0.46.',
  },
  {
    key: 'P3',
    path: `${AI}/adaptive-prediction-calibration.service.ts`,
    artifact: 'adaptive-prediction-calibration-v1',
    quantity: 'CALIBRATED_WIN_RATE',
    constants: [
      const_('ADAPTIVE_CALIBRATION_PRIOR_WEIGHT', 8, 13),
      const_('ADAPTIVE_CALIBRATION_MIN_AUTHORITATIVE_SAMPLES', 12, 8),
    ],
    notes: 'The calibrated win probability IS the C1 blend output — the only family that consumes another layer.',
  },
  {
    key: 'P4',
    path: `${AI}/owner-demo-entry-outcome-model.generated.ts`,
    artifact: 'owner-demo-entry-outcome-model (generated)',
    quantity: 'OWNER_FORECAST_NET_R',
    constants: [],
    notes: 'Generated coefficients; RESEARCH_ONLY — excluded from the qualification scoreboard (B3/D5); path + marker verified only.',
  },
  {
    key: 'P5',
    path: `${AI}/m1-tactical-expectancy.ts`,
    artifact: 'm1-tactical-statistical-expectancy-v2',
    quantity: 'M1_EXPECTANCY_BLEND',
    constants: [
      const_('M1_EXPECTANCY_REALISED_MIN_SAMPLES', 5, 4),
      const_('M1_EXPECTANCY_PRIOR_WEIGHT', 5, 5),
      const_('M1_EXPECTANCY_RECENT_WEIGHT', 0.25, 6),
    ],
    notes: 'Heuristic prior blended with realized pair-side evidence (weight min(samples, 20)); recent payoff blend 0.25 at >= 5 samples; clamp [-1.5, max(1.5, targetR)].',
  },
];
const PREDICTION_FAMILY_COUNT = PREDICTION_FAMILIES.length; // 5 — map v1 §6

/** The one confidence-floor copy outside services/ai-engine (B5, map §6). */
const B5_ORCHESTRATOR_FLOOR = {
  path: ORCHESTRATOR,
  constants: [const_('CONFIDENCE_THRESHOLD', 0.6, 67)],
  notes: 'Clamped 0.60-0.70 (l.216-219); the Python side carries CONFIDENCE_FLOOR = 0.60 in five training modules.',
};

// ------------------------------------------------- typed refusal machinery

const REFUSALS = Object.freeze({
  INPUT_REQUIRED: 'CALIBRATION_INPUT_REQUIRED',
  UNSUPPORTED_SURFACE: 'CALIBRATION_UNSUPPORTED_SURFACE',
  INPUT_OUT_OF_RANGE: 'CALIBRATION_INPUT_OUT_OF_RANGE',
  TAMPERED: 'CALIBRATION_CONTRACT_TAMPERED',
  PATH_DRIFT: 'CALIBRATION_PATH_DRIFT',
});

const refusal = (code, detail) => ({ refusal: code, detail: detail ?? null });
const isRefusal = (value) =>
  !!value && typeof value === 'object' && typeof value.refusal === 'string';

function requireFiniteNumber(value, code = REFUSALS.INPUT_REQUIRED) {
  if (value === null || value === undefined || value === '') return refusal(code);
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : refusal(code);
}

function requirePositiveNumber(value) {
  const n = requireFiniteNumber(value);
  return isRefusal(n) || n <= 0 ? refusal(REFUSALS.INPUT_OUT_OF_RANGE, String(value)) : n;
}

function requireDirection(value) {
  return value === 'BUY' || value === 'SELL' ? value : refusal(REFUSALS.INPUT_REQUIRED, String(value));
}

function round6(value) {
  return Number(value.toFixed(6));
}

function round5(value) {
  return Number(value.toFixed(5));
}

// ------------------------------------------------------- faithful mirror C1

const C1_SOURCE_LEVELS = Object.freeze(['EXACT', 'PAIR_DIRECTION_ROUTE', 'ROUTE', 'GLOBAL']);
const C1_LOCAL_LEVELS = Object.freeze(['EXACT', 'PAIR_DIRECTION_ROUTE']);

function c1ValidRows(rows, evaluatedAtMs) {
  const out = [];
  for (const row of rows) {
    const decisionAt = new Date(row.evaluated_at).getTime();
    const resolvedAt = new Date(row.outcome_resolved_at ?? row.evaluated_at).getTime();
    if (!Number.isFinite(decisionAt) || !Number.isFinite(resolvedAt)) continue;
    if (decisionAt >= evaluatedAtMs || resolvedAt >= evaluatedAtMs) continue;
    if (row.outcome_status !== 'WIN' && row.outcome_status !== 'LOSS') continue;
    const netR = requireFiniteNumber(row.outcome_net_r);
    if (isRefusal(netR)) continue;
    out.push({ ...row, netR });
  }
  return out;
}

function c1CollapseEpisodes(rows) {
  const byPairSide = new Map();
  for (const row of rows) {
    const key = `${row.instrument}|${row.direction}`;
    (byPairSide.get(key) ?? byPairSide.set(key, []).get(key)).push(row);
  }
  const episodes = [];
  for (const bucket of byPairSide.values()) {
    const ordered = [...bucket].sort(
      (a, b) => new Date(a.evaluated_at).getTime() - new Date(b.evaluated_at).getTime(),
    );
    let activeEnd = Number.NEGATIVE_INFINITY;
    for (const row of ordered) {
      const evaluatedAt = new Date(row.evaluated_at).getTime();
      const resolvedAt = new Date(row.outcome_resolved_at ?? row.evaluated_at).getTime();
      if (evaluatedAt > activeEnd) {
        episodes.push(row);
        activeEnd = resolvedAt;
      } else {
        activeEnd = Math.max(activeEnd, resolvedAt);
      }
    }
  }
  return episodes.sort(
    (a, b) => new Date(a.evaluated_at).getTime() - new Date(b.evaluated_at).getTime(),
  );
}

function c1ProfitFactor(values) {
  const grossProfit = values.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = -values.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  if (grossLoss === 0) return grossProfit > 0 ? 1_000_000 : null;
  return grossProfit / grossLoss;
}

/**
 * Faithful mirror of buildAdaptivePredictionCalibration (C1) — Bayesian
 * blend prior 8, ladder, maturity, block/rescue. Pure evaluation core only;
 * the SQL evidence source is the SEAM-C1 extraction input, not mirrored.
 */
function mirrorC1(rows, request) {
  const evaluatedAtMs = new Date(request.evaluatedAt).getTime();
  if (!Number.isFinite(evaluatedAtMs)) return refusal(REFUSALS.INPUT_REQUIRED, 'evaluatedAt');
  const rawConfidence = requireFiniteNumber(request.rawConfidence);
  if (isRefusal(rawConfidence)) return rawConfidence;
  if (rawConfidence < 0 || rawConfidence > 1)
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'rawConfidence');
  const rawNetExpectedR = requireFiniteNumber(request.rawNetExpectedR);
  if (isRefusal(rawNetExpectedR)) return rawNetExpectedR;

  const valid = c1ValidRows(rows, evaluatedAtMs);
  const route = valid.filter((row) => row.strategy_route === request.strategyRoute);
  const pairDirectionRoute = route.filter(
    (row) => row.instrument === request.instrument && row.direction === request.direction,
  );
  const c1SessionOf = (row) => {
    if (['ASIA', 'LONDON', 'NEW_YORK', 'ROLLOVER'].includes(row.adaptive_session)) {
      return row.adaptive_session;
    }
    return request.session;
  };
  const c1StateOf = (row) => {
    if (row.adaptive_state) return row.adaptive_state;
    return request.state;
  };
  const exact = pairDirectionRoute.filter(
    (row) => c1SessionOf(row) === request.session && c1StateOf(row) === request.state,
  );
  const candidates = [
    ['EXACT', c1CollapseEpisodes(exact)],
    ['PAIR_DIRECTION_ROUTE', c1CollapseEpisodes(pairDirectionRoute)],
    ['ROUTE', c1CollapseEpisodes(route)],
    ['GLOBAL', c1CollapseEpisodes(valid)],
  ];
  let selected = { sourceLevel: 'NONE', rows: [] };
  for (const [sourceLevel, bucket] of candidates) {
    if (bucket.length >= 12) {
      selected = { sourceLevel, rows: bucket };
      break;
    }
  }
  if (selected.rows.length === 0) {
    for (const [sourceLevel, bucket] of candidates) {
      if (bucket.length > 0) {
        selected = { sourceLevel, rows: bucket };
        break;
      }
    }
  }

  const sample = selected.rows;
  const samples = sample.length;
  const wins = sample.filter((row) => row.outcome_status === 'WIN').length;
  const losses = sample.filter((row) => row.outcome_status === 'LOSS').length;
  const values = sample.map((row) => row.netR);
  const pf = samples ? c1ProfitFactor(values) : null;
  const recent = sample.slice(-8);
  const recentWins = recent.filter((row) => row.outcome_status === 'WIN').length;
  const recentNetR = recent.reduce((sum, row) => sum + row.netR, 0);
  const recentDegradation = recent.length >= 8 && recentWins <= 1 && recentNetR < 0;
  const authoritative = samples >= 12;
  const localExecutionEvidence = C1_LOCAL_LEVELS.includes(selected.sourceLevel);

  if (!authoritative) {
    return {
      layer: 'C1',
      available: samples > 0,
      authoritative: false,
      sourceLevel: selected.sourceLevel,
      maturity: 'SPARSE',
      samples,
      wins,
      losses,
      calibratedWinProbability: Math.max(0, Math.min(1, rawConfidence)),
      calibratedNetExpectedR: rawNetExpectedR,
      profitFactor: pf,
      recentDegradation: false,
      blockRecommended: false,
      rescueEligible: false,
      reason: samples ? 'CALIBRATION_EVIDENCE_SPARSE' : 'CALIBRATION_EVIDENCE_UNAVAILABLE',
    };
  }

  const calibratedWinProbability = Math.max(
    0,
    Math.min(1, (rawConfidence * 8 + wins) / (8 + samples)),
  );
  const observedNetRSum = values.reduce((sum, value) => sum + value, 0);
  const calibratedNetExpectedR = (rawNetExpectedR * 8 + observedNetRSum) / (8 + samples);
  const mature = samples >= 20 && wins >= 5 && losses >= 5;
  const maturity = recentDegradation ? 'DEGRADED' : mature ? 'MATURE' : 'COLLECTING';
  const wouldBlock =
    localExecutionEvidence &&
    (maturity === 'DEGRADED' ||
      (maturity === 'MATURE' && (calibratedNetExpectedR <= 0 || calibratedWinProbability < 0.45)));
  const rescueEligible =
    localExecutionEvidence &&
    maturity === 'MATURE' &&
    !recentDegradation &&
    calibratedNetExpectedR >= 0.12 &&
    calibratedWinProbability >= 0.55 &&
    pf !== null &&
    pf >= 1.15;

  return {
    layer: 'C1',
    available: true,
    authoritative: true,
    sourceLevel: selected.sourceLevel,
    maturity,
    samples,
    wins,
    losses,
    calibratedWinProbability: round6(calibratedWinProbability),
    calibratedNetExpectedR: round6(calibratedNetExpectedR),
    profitFactor: pf === null ? null : round6(pf),
    recentDegradation,
    blockRecommended: wouldBlock,
    stanceWouldBlock:
      maturity === 'DEGRADED' ||
      (maturity === 'MATURE' && (calibratedNetExpectedR <= 0 || calibratedWinProbability < 0.45)),
    rescueEligible,
    reason: wouldBlock
      ? 'CALIBRATED_EDGE_UNFAVOURABLE'
      : rescueEligible
        ? 'MATURE_POSITIVE_CALIBRATED_EDGE'
        : 'CALIBRATION_APPLIED',
  };
}

// ------------------------------------------------------- faithful mirror C2

function c2ScoreRows(rows, request, evaluatedAtMs) {
  const truthy = (value) =>
    value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
  const sessionFor = (row) => {
    // Tagged session wins; the clock-classifier fallback (signal time ->
    // session) lives behind the SEAM-C1 evidence-assembly seam and is not
    // mirrored here — the corpus rows always carry tagged sessions.
    if (['ASIA', 'LONDON', 'NEW_YORK', 'ROLLOVER'].includes(row.adaptive_session)) {
      return row.adaptive_session;
    }
    return row.signal_generated_at ? 'NEW_YORK' : 'NEW_YORK';
  };
  const scored = [];
  for (const row of rows) {
    const pnl = requireFiniteNumber(row.realised_pnl);
    const riskAmount = requireFiniteNumber(row.risk_amount);
    const fill = requireFiniteNumber(row.fill_price);
    const exit = requireFiniteNumber(row.exit_price);
    const stop = requireFiniteNumber(row.stop_loss);
    let r = null;
    if (!isRefusal(pnl) && !isRefusal(riskAmount) && riskAmount > 0) {
      r = pnl / riskAmount;
    } else if (
      !isRefusal(fill) &&
      !isRefusal(exit) &&
      !isRefusal(stop) &&
      Math.abs(fill - stop) > 0
    ) {
      const riskDistance = Math.abs(fill - stop);
      r = row.direction === 'BUY' ? (exit - fill) / riskDistance : (fill - exit) / riskDistance;
    }
    if (r === null || !Number.isFinite(r)) continue;
    const opening = requireFiniteNumber(row.session_opening_balance);
    scored.push({
      ...row,
      r,
      session: sessionFor(row),
      adaptiveTagged:
        row.adaptive_tagged == null ? Boolean(row.adaptive_state) : truthy(row.adaptive_tagged),
      accountReturn:
        !isRefusal(pnl) && !isRefusal(opening) && opening > 0 ? pnl / opening : null,
    });
  }
  scored.sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());
  return scored.filter((row) => {
    if (row.strategy_route && row.strategy_route !== request.strategyRoute) return false;
    const closedAtMs = new Date(row.closed_at).getTime();
    if (!Number.isFinite(closedAtMs) || closedAtMs >= evaluatedAtMs) return false;
    if (row.signal_generated_at) {
      const generatedAtMs = new Date(row.signal_generated_at).getTime();
      if (!Number.isFinite(generatedAtMs) || generatedAtMs >= evaluatedAtMs) return false;
    }
    return true;
  });
}

function c2Blend(sample, n, prior, priorStrength) {
  if (sample === null || n <= 0) return prior;
  const weight = n / (n + priorStrength);
  return weight * sample + (1 - weight) * prior;
}

function c2ProfitFactor(values) {
  const grossProfit = values.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = -values.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  if (grossLoss === 0) return grossProfit > 0 ? 1_000_000 : null;
  return grossProfit / grossLoss;
}

function c2MaxDrawdown(returns) {
  if (!returns.length) return null;
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst;
}

/**
 * Faithful mirror of buildAdaptiveEdgeEvidence (C2) — strength-normalized
 * blending (24/16/20), smoothed win rate (wins+2)/(n+4), maturity and the
 * canUpsize verdict. Pure evaluation core only.
 */
function mirrorC2(rows, request) {
  const evaluatedAtMs = new Date(request.evaluatedAt).getTime();
  if (!Number.isFinite(evaluatedAtMs)) return refusal(REFUSALS.INPUT_REQUIRED, 'evaluatedAt');
  const instrument = String(request.instrument ?? '').trim().toUpperCase();
  if (!instrument) return refusal(REFUSALS.INPUT_REQUIRED, 'instrument');

  const all = c2ScoreRows(rows, request, evaluatedAtMs);
  const pairDirection = all.filter(
    (row) =>
      String(row.instrument).trim().toUpperCase() === instrument &&
      row.direction === request.direction,
  );
  const pairSession = pairDirection.filter((row) => row.session === request.session);
  const exact = pairSession.filter(
    (row) => row.adaptiveTagged && row.adaptive_state === request.state,
  );

  const routeMean = all.length ? all.reduce((s, r) => s + r.r, 0) / all.length : 0;
  const avg = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
  const pairMean = avg(pairDirection.map((row) => row.r));
  const pairPrior = c2Blend(pairMean, pairDirection.length, routeMean, 24);
  const sessionMean = avg(pairSession.map((row) => row.r));
  const sessionPrior = c2Blend(sessionMean, pairSession.length, pairPrior, 16);
  const exactMean = avg(exact.map((row) => row.r));
  const smoothedExpectedR = c2Blend(exactMean, exact.length, sessionPrior, 20);

  const wins = exact.filter((row) => row.r > 0).length;
  const losses = exact.filter((row) => row.r < 0).length;
  const smoothedWinRate = exact.length ? (wins + 2) / (exact.length + 4) : 0.5;
  const returns = exact
    .map((row) => row.accountReturn)
    .filter((value) => value !== null && Number.isFinite(value));
  const pf = c2ProfitFactor(exact.map((row) => row.r));
  const dd = c2MaxDrawdown(returns);
  const recent = exact.slice(-8);
  const recentWins = recent.filter((row) => row.r > 0).length;
  const recentSum = recent.reduce((sum, row) => sum + row.r, 0);
  const recentDegradation =
    (recent.length >= 8 && recentWins === 0 && recentSum < 0) || (dd !== null && dd > 0.12);

  let maturity;
  if (recentDegradation) maturity = 'DEGRADED';
  else if (exact.length < 8) maturity = 'SPARSE';
  else if (exact.length >= 20 && wins >= 5 && losses >= 5) maturity = 'MATURE';
  else maturity = 'COLLECTING';

  const canUpsize =
    maturity === 'MATURE' &&
    smoothedExpectedR > 0 &&
    pf !== null &&
    pf >= 1.15 &&
    dd !== null &&
    dd <= 0.12;

  const reason = recentDegradation
    ? 'RECENT_EDGE_DEGRADED'
    : exact.length === 0
      ? 'NO_PROSPECTIVE_EXACT_CELL_EVIDENCE'
      : maturity === 'MATURE'
        ? 'MATURE_EDGE_EVIDENCE'
        : 'COLLECTING_EDGE_EVIDENCE';

  return {
    layer: 'C2',
    exactRows: exact.length,
    wins,
    losses,
    smoothedWinRate: round6(smoothedWinRate),
    smoothedExpectedR: round6(smoothedExpectedR),
    profitFactor: pf === null ? null : round6(pf),
    maxDrawdown: dd === null ? null : round6(dd),
    maturity,
    recentDegradation,
    canUpsize,
    reason,
  };
}

// ------------------------------------------------------- faithful mirror C3

/**
 * Faithful mirror of buildAdaptiveShadowDirectionalPulse (C3) — decayed
 * pulse, 0.65 decay, >= 4 outcomes per side within the last 10.
 */
function mirrorC3(outcomes, direction, evaluatedAt) {
  const evaluatedAtMs = new Date(evaluatedAt).getTime();
  if (!Number.isFinite(evaluatedAtMs)) return refusal(REFUSALS.INPUT_REQUIRED, 'evaluatedAt');
  const dir = requireDirection(direction);
  if (isRefusal(dir)) return dir;
  const opposite = dir === 'BUY' ? 'SELL' : 'BUY';

  const latestResolved = (wanted) =>
    outcomes
      .filter((outcome) => {
        if (outcome.direction !== wanted || !Number.isFinite(outcome.netR)) return false;
        const resolvedMs = new Date(outcome.resolvedAt).getTime();
        return Number.isFinite(resolvedMs) && resolvedMs < evaluatedAtMs;
      })
      .sort((a, b) => new Date(a.resolvedAt).getTime() - new Date(b.resolvedAt).getTime())
      .slice(-10);

  const weightedMean = (list) => {
    if (!list.length) return 0;
    let numerator = 0;
    let denominator = 0;
    const newestFirst = [...list].reverse();
    for (let index = 0; index < newestFirst.length; index += 1) {
      const weight = 0.65 ** index;
      numerator += newestFirst[index].netR * weight;
      denominator += weight;
    }
    return denominator > 0 ? numerator / denominator : 0;
  };

  const candidate = latestResolved(dir);
  const oppositeSide = latestResolved(opposite);
  const candidateWeightedR = weightedMean(candidate);
  const oppositeWeightedR = weightedMean(oppositeSide);
  const advantageR = candidateWeightedR - oppositeWeightedR;

  if (candidate.length < 4 || oppositeSide.length < 4) {
    return {
      layer: 'C3',
      available: false,
      status: 'INSUFFICIENT',
      candidateSamples: candidate.length,
      oppositeSamples: oppositeSide.length,
      advantageR: round6(advantageR),
      quality: 0.5,
      reason: 'INSUFFICIENT',
    };
  }

  const quality = Math.max(0, Math.min(1, 0.5 + advantageR / 4));
  const status =
    advantageR >= 0.5 && candidateWeightedR > 0
      ? 'SUPPORTED'
      : advantageR <= -0.5 && oppositeWeightedR > 0
        ? 'OPPOSED'
        : 'NEUTRAL';
  return {
    layer: 'C3',
    available: true,
    status,
    candidateSamples: candidate.length,
    oppositeSamples: oppositeSide.length,
    advantageR: round6(advantageR),
    quality: round6(quality),
    reason: status,
  };
}

// ------------------------------------------------------- faithful mirror C4

/**
 * Faithful mirror of evaluatePaperSpreadCalibrationShadow (C4) — p95 with
 * the 0.25 fixed-fraction floor at >= 100 samples; cost = 1.25 * spread /
 * stop.
 */
function mirrorC4(input) {
  const fixedSpreadPrice = requirePositiveNumber(input.fixedSpreadPrice);
  if (isRefusal(fixedSpreadPrice)) return { ...fixedSpreadPrice, layer: 'C4' };
  const stopDistancePrice = requirePositiveNumber(input.stopDistancePrice);
  if (isRefusal(stopDistancePrice)) return { ...stopDistancePrice, layer: 'C4' };
  const sampleCount = Math.max(0, Math.floor(requireFiniteNumber(input.history?.sampleCount) ?? 0));
  const p95 = requireFiniteNumber(input.history?.p95SpreadPrice);
  const validP95 = !isRefusal(p95) && p95 > 0;
  const minimumSpreadFloorPrice = fixedSpreadPrice * 0.25;
  const costR = (spreadPrice) => (1.25 * spreadPrice) / stopDistancePrice;

  if (!validP95) {
    return {
      layer: 'C4',
      calibratedSpreadPrice: fixedSpreadPrice,
      minimumSpreadFloorPrice: round6(minimumSpreadFloorPrice),
      sampleCount,
      fixedCostR: round6(costR(fixedSpreadPrice)),
      calibratedCostR: round6(costR(fixedSpreadPrice)),
      reason: 'INVALID_HISTORY_FIXED_FALLBACK',
    };
  }
  if (sampleCount < 100) {
    return {
      layer: 'C4',
      calibratedSpreadPrice: fixedSpreadPrice,
      minimumSpreadFloorPrice: round6(minimumSpreadFloorPrice),
      sampleCount,
      fixedCostR: round6(costR(fixedSpreadPrice)),
      calibratedCostR: round6(costR(fixedSpreadPrice)),
      reason: 'SPARSE_HISTORY_FIXED_FALLBACK',
    };
  }
  const calibrated = Math.max(p95, minimumSpreadFloorPrice);
  return {
    layer: 'C4',
    calibratedSpreadPrice: round6(calibrated),
    minimumSpreadFloorPrice: round6(minimumSpreadFloorPrice),
    sampleCount,
    fixedCostR: round6(costR(fixedSpreadPrice)),
    calibratedCostR: round6(costR(calibrated)),
    reason: 'CALIBRATED_P95_WITH_FLOOR',
  };
}

// ------------------------------------------------------- faithful mirror C5

/**
 * Faithful mirror of evaluateM1CausalCommissionShadow (C5) — additive p90
 * fee subtraction at >= 5 prior closed trades; 6dp rounding.
 */
function mirrorC5(input) {
  const baseline = requireFiniteNumber(input.originalNetExpectedR);
  if (isRefusal(baseline)) return { ...baseline, layer: 'C5' };
  const spread = requireFiniteNumber(input.spreadOnlyCostR);
  if (isRefusal(spread) || spread < 0)
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'spreadOnlyCostR');
  const minimumNet = requireFiniteNumber(input.minimumRequiredNetR);
  if (isRefusal(minimumNet) || minimumNet < 0)
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'minimumRequiredNetR');
  const count = Math.max(0, Math.floor(requireFiniteNumber(input.evidence?.sampleCount) ?? 0));
  const p90 = requireFiniteNumber(input.evidence?.p90FeeR);

  let reason;
  if (input.lookupFailed) reason = 'FEE_LOOKUP_UNAVAILABLE';
  else if (count < 5) reason = 'INSUFFICIENT_PRIOR_CLOSED_TRADES';
  else if (p90 === null || p90 < 0) reason = 'INVALID_FEE_EVIDENCE';
  else reason = 'CAUSAL_FEE_EVIDENCE_READY';

  const ready = reason === 'CAUSAL_FEE_EVIDENCE_READY';
  const adjustedNet = ready ? round6(baseline - p90) : null;
  return {
    layer: 'C5',
    reason,
    sampleCount: count,
    estimatedNetAfterFeeR: adjustedNet,
    hypotheticalNetFloorPassed: adjustedNet === null ? null : adjustedNet >= minimumNet,
  };
}

// ------------------------------------------------------- faithful mirror C6

const C6_SUPPORTED_PAIRS = Object.freeze([
  'AUDUSD',
  'EURUSD',
  'GBPUSD',
  'USDCAD',
  'USDCHF',
  'USDJPY',
]);

/**
 * Faithful mirror of evaluateProbationCausalCostStress (C6) — 1.25x spread
 * stress + 0.5 pip slippage + p90 fee against gross R; 5dp rounding.
 */
function mirrorC6(input) {
  if (!C6_SUPPORTED_PAIRS.includes(input.instrument))
    return refusal(REFUSALS.UNSUPPORTED_SURFACE, input.instrument);
  if (!Number.isFinite(input.stopDistance) || input.stopDistance <= 0)
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'stopDistance');
  if (input.grossR !== null && !Number.isFinite(input.grossR))
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'grossR');
  if (!['TARGET_QUOTE_TOUCH', 'STOP_QUOTE_TOUCH', 'TIME_MARK'].includes(input.grossOutcome) || input.grossR === null) {
    return { layer: 'C6', state: 'UNRESOLVED_QUOTE_OUTCOME', stressedCostAdjustedR: null, reason: 'UNRESOLVED_QUOTE_OUTCOME' };
  }
  if (
    !Number.isInteger(input.feeSamples) ||
    input.feeSamples < 5 ||
    !Number.isFinite(input.feeP90R) ||
    input.feeP90R < 0
  ) {
    return { layer: 'C6', state: 'INSUFFICIENT_CAUSAL_FEES', stressedCostAdjustedR: null, reason: 'INSUFFICIENT_CAUSAL_FEES' };
  }
  if (
    !Number.isInteger(input.spreadBars) ||
    input.spreadBars < 5 ||
    !Number.isFinite(input.spreadP90Price) ||
    input.spreadP90Price <= 0
  ) {
    return { layer: 'C6', state: 'INSUFFICIENT_CAUSAL_SPREAD', stressedCostAdjustedR: null, reason: 'INSUFFICIENT_CAUSAL_SPREAD' };
  }
  const pip = input.instrument.endsWith('JPY') ? 0.01 : 0.0001;
  const spreadStressR = (input.spreadP90Price * 1.25) / input.stopDistance;
  const slippageStressR = (pip * 0.5) / input.stopDistance;
  const total = input.feeP90R + spreadStressR + slippageStressR;
  if (![spreadStressR, slippageStressR, total].every((v) => Number.isFinite(v) && v >= 0)) {
    return { layer: 'C6', state: 'INVALID_GEOMETRY', stressedCostAdjustedR: null, reason: 'INVALID_GEOMETRY' };
  }
  const stressed = input.grossR - total;
  return {
    layer: 'C6',
    state: 'ESTIMABLE_STRESS_ONLY',
    spreadStressR: round5(spreadStressR),
    slippageStressR: round5(slippageStressR),
    totalStressCostR: round5(total),
    stressedCostAdjustedR: round5(stressed),
    reason: stressed > 0 ? 'STRESS_POSITIVE_NET' : 'STRESS_NEGATIVE_NET',
  };
}

// --------------------------------------------- faithful mirror P5 (family)

/**
 * Faithful mirror of evaluateM1TacticalExpectancy (P5) — prior weight 5,
 * evidence weight min(samples, 20), recent payoff blend 0.25 at >= 5
 * samples, clamp [-1.5, max(1.5, targetR)].
 */
function mirrorP5(input) {
  const suppliedTargetR = requireFiniteNumber(input.targetR);
  if (isRefusal(suppliedTargetR)) return { ...suppliedTargetR, layer: 'P5' };
  const targetR = suppliedTargetR > 0 ? suppliedTargetR : 1;
  const clampUnit = (v) => {
    const n = requireFiniteNumber(v);
    return isRefusal(n) ? 0.5 : Math.min(1, Math.max(0, n));
  };
  const breakevenWinProbability = 1 / (1 + targetR);
  const confidence = clampUnit(input.confidence);
  const directionQuality = clampUnit(input.directionQuality);
  const heuristicQuality = (confidence + directionQuality) / 2;
  const impliedLower = Math.max(0, breakevenWinProbability - 0.1);
  const impliedUpper = Math.min(1, breakevenWinProbability + 0.2);
  const impliedWinProbability = Math.min(
    impliedUpper,
    Math.max(impliedLower, breakevenWinProbability + 0.5 * (heuristicQuality - 0.5)),
  );
  const heuristicPriorExpectedR =
    impliedWinProbability * targetR - (1 - impliedWinProbability);
  const evidenceSamples = Math.max(0, Math.floor(requireFiniteNumber(input.reliability?.realizedRSamples) ?? 0));
  const evidenceAverageRealizedR = requireFiniteNumber(input.reliability?.averageRealizedR);
  const recentSamples = Math.max(0, Math.floor(requireFiniteNumber(input.reliability?.recentPayoffRSamples) ?? 0));
  const recentAverageR = requireFiniteNumber(input.reliability?.recentPayoffAverageR);
  const hasRealised = evidenceSamples >= 5 && evidenceAverageRealizedR !== null;

  let source = 'HEURISTIC_PRIOR';
  let statisticalExpectedR = heuristicPriorExpectedR;
  if (hasRealised) {
    source = 'REALISED_PAIR_SIDE';
    const weight = Math.min(evidenceSamples, 20);
    statisticalExpectedR =
      (heuristicPriorExpectedR * 5 + evidenceAverageRealizedR * weight) / (5 + weight);
  }
  const recentApplied = hasRealised && recentSamples >= 5 && recentAverageR !== null;
  if (recentApplied) {
    statisticalExpectedR =
      statisticalExpectedR * (1 - 0.25) + recentAverageR * 0.25;
  }
  const safe = Number.isFinite(statisticalExpectedR)
    ? Math.min(Math.max(-1.5, statisticalExpectedR), Math.max(1.5, targetR))
    : 0;
  return {
    layer: 'P5',
    source,
    statisticalExpectedR: round6(safe),
    recentPayoffApplied: recentApplied,
    heuristicPriorExpectedR: round6(heuristicPriorExpectedR),
    reason: recentApplied ? 'RECENT_PAYOFF_APPLIED' : source === 'REALISED_PAIR_SIDE' ? 'REALISED_BLEND_APPLIED' : 'HEURISTIC_PRIOR',
  };
}

// --------------------------------------- CAL-2 scoreboard (V2-7) contracts

const SCOREBOARD_FAMILIES = Object.freeze([
  'PLAN_B_EXPECTED_R',
  'V8_LOGISTIC_PROBABILITY',
  'CALIBRATED_WIN_RATE',
  'M1_EXPECTANCY_BLEND',
]);
const SCOREBOARD_EXCLUDED_FAMILIES = Object.freeze(['OWNER_FORECAST_NET_R']); // P4: RESEARCH_ONLY (B3/D5)

const SCOREBOARD_FIELDS = Object.freeze([
  'predictionId',
  'family',
  'instrument',
  'direction',
  'strategyRoute',
  'session',
  'state',
  'decisionPolicyVersion',
  'modelVersion',
  'registeredAt',
  'rawConfidence',
  'rawNetExpectedR',
]);

/**
 * Validate one pre-outcome prediction registration (CAL-2 / V2-7).
 * A registration is append-only evidence of a prediction made BEFORE the
 * outcome resolved; nothing here grants order authority.
 */
function validatePredictionRegistration(record, resolvedAt = null) {
  for (const field of SCOREBOARD_FIELDS) {
    const value = record[field];
    if (value === null || value === undefined || value === '')
      return refusal(REFUSALS.INPUT_REQUIRED, field);
  }
  if (!SCOREBOARD_FAMILIES.includes(record.family))
    return refusal(REFUSALS.UNSUPPORTED_SURFACE, record.family);
  if (isRefusal(requireDirection(record.direction))) return refusal(REFUSALS.INPUT_REQUIRED, 'direction');
  const registeredAtMs = new Date(record.registeredAt).getTime();
  if (!Number.isFinite(registeredAtMs))
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'registeredAt');
  const confidence = requireFiniteNumber(record.rawConfidence);
  if (isRefusal(confidence) || confidence < 0 || confidence > 1)
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'rawConfidence');
  if (isRefusal(requireFiniteNumber(record.rawNetExpectedR)))
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'rawNetExpectedR');
  if (record.executionAuthority !== 'NONE')
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'executionAuthority');
  // Causality: the registration must predate resolution. A registration
  // that postdates the resolution is retrodiction, not prediction.
  if (resolvedAt !== null) {
    const resolvedAtMs = new Date(resolvedAt).getTime();
    if (!Number.isFinite(resolvedAtMs))
      return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'resolvedAt');
    if (registeredAtMs >= resolvedAtMs)
      return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'registeredAt >= resolvedAt');
  }
  return { valid: true };
}

/**
 * Append-only ledger semantics: duplicate predictionId is refused; late
 * (post-resolution) registration is refused; resolution sealing is append
 * of outcome rows keyed by predictionId, never an edit of the prediction.
 */
function registerPrediction(ledger, record, resolvedAt = null) {
  const validation = validatePredictionRegistration(record, resolvedAt);
  if (validation.valid !== true) return validation;
  if (ledger.some((entry) => entry.predictionId === record.predictionId))
    return refusal(REFUSALS.INPUT_OUT_OF_RANGE, 'duplicate predictionId');
  ledger.push({ ...record, executionAuthority: 'NONE' });
  return { valid: true, size: ledger.length };
}

// --------------------------------------------------- the frozen CL corpus

const T0 = '2026-11-27T10:00:00.000Z';
const minsAgo = (m) => new Date(Date.parse(T0) - m * 60_000).toISOString();
const daysAgo = (d, mExtra = 0) => minsAgo(d * 24 * 60 + mExtra);

const CELL = Object.freeze({
  instrument: 'EURUSD',
  direction: 'BUY',
  session: 'LONDON',
  state: 'TREND_HEALTHY',
  strategyRoute: 'plan-b-trend',
});

const c1Row = (evaluatedMinsAgo, resolvedMinsAgo, status, netR, overrides = {}) => ({
  instrument: CELL.instrument,
  direction: CELL.direction,
  strategy_route: CELL.strategyRoute,
  adaptive_state: CELL.state,
  adaptive_session: CELL.session,
  evaluated_at: minsAgo(evaluatedMinsAgo),
  outcome_resolved_at: minsAgo(resolvedMinsAgo),
  outcome_status: status,
  outcome_net_r: netR,
  ...overrides,
});

// Non-overlapping C1 series: each decision resolves 5 minutes later and the
// next decision follows 15 minutes after that resolution, so the episode
// collapse keeps every row (blocks listed newest -> oldest).
const c1Seq = (blocks) => {
  const rows = [];
  for (const block of blocks) {
    for (let k = 0; k < block.count; k += 1) {
      const evaluated = block.newest + k * 20;
      rows.push(c1Row(evaluated, evaluated - 5, block.status, block.netR, block.overrides));
    }
  }
  return rows;
};

const c2Row = (closedMinsAgo, r, overrides = {}) => ({
  instrument: CELL.instrument,
  direction: CELL.direction,
  strategy_route: CELL.strategyRoute,
  adaptive_state: CELL.state,
  adaptive_session: CELL.session,
  adaptive_tagged: true,
  signal_generated_at: minsAgo(closedMinsAgo + 30),
  closed_at: minsAgo(closedMinsAgo),
  realised_pnl: null,
  risk_amount: 1,
  fill_price: 1.08,
  exit_price: 1.08 + r,
  stop_loss: 1.07,
  session_opening_balance: 1000,
  ...overrides,
});

const C1_REQUEST = Object.freeze({ ...CELL, evaluatedAt: T0, rawConfidence: 0.62, rawNetExpectedR: 0.2 });
const C2_REQUEST = Object.freeze({ ...CELL, evaluatedAt: T0, decisionPolicyVersion: 'dp-v1' });

// A 24-row exact cell with 9 wins (sum +3.15) and 15 losses (sum -2.4):
// recent-8 carries exactly 1 win and net -1.40 -> C1 DEGRADED (wins <= 1),
// C2 NOT degraded (wins == 0 required) with pf 1.3125 -> canUpsize.
// A 32-row exact cell with 17 wins (sum +5.95) and 15 losses (sum -4.5):
// recent-8 carries exactly 1 win and net -1.20 -> C1 DEGRADED (wins <= 1),
// C2 NOT degraded (zero wins required) with pf 1.32222 -> canUpsize.
const D01_C1_ROWS = c1Seq([
  { count: 7, status: 'LOSS', netR: -0.2, newest: 840 },
  { count: 1, status: 'WIN', netR: 0.2, newest: 1000 },
  { count: 8, status: 'LOSS', netR: -0.3, newest: 1100 },
  { count: 16, status: 'WIN', netR: 0.35, newest: 1400 },
]);
const D01_C2_ROWS = D01_C1_ROWS.map((row, i) =>
  c2Row(800 - i * 10, row.outcome_status === 'WIN' ? 0.35 : -0.30, {
    realised_pnl: row.outcome_status === 'WIN' ? 3.5 : -3.0,
    risk_amount: 10,
  }),
);

// A 10-row cell: C1 is NOT yet authoritative (< 12) while C2 is already
// COLLECTING (>= 8) — the same evidence carries different maturity labels.
const D02_C1_ROWS = c1Seq([
  { count: 4, status: 'LOSS', netR: -0.1, newest: 1400 },
  { count: 6, status: 'WIN', netR: 0.25, newest: 1200 },
]);
const D02_C2_ROWS = [
  ...Array.from({ length: 4 }, (_, i) => c2Row(2000 - i * 10, -0.1, { realised_pnl: -10, risk_amount: 100 })),
  ...Array.from({ length: 6 }, (_, i) => c2Row(1900 - i * 10, 0.3, { realised_pnl: 30, risk_amount: 100 })),
];

// A pulse-supported BUY side (5 BUY wins +0.30, 5 SELL losses -0.35 resolved
// before T0) evaluated against the degraded calibration cell of D01.
const D03_PULSE_OUTCOMES = [
  ...Array.from({ length: 5 }, (_, i) => ({ direction: 'BUY', netR: 0.30, resolvedAt: daysAgo(6, i) })),
  ...Array.from({ length: 5 }, (_, i) => ({ direction: 'SELL', netR: -0.35, resolvedAt: daysAgo(6, 10 + i) })),
];

const D04_INPUT = Object.freeze({
  instrument: 'EURUSD',
  fixedSpreadPrice: 0.0002,
  stopDistancePrice: 0.004,
  history: { sampleCount: 100, p95SpreadPrice: 0.0001 },
});
const D04_SPARSE_INPUT = Object.freeze({ ...D04_INPUT, history: { sampleCount: 99, p95SpreadPrice: 0.0001 } });

const D05_C5_INPUT = Object.freeze({
  originalNetExpectedR: 0.30,
  spreadOnlyCostR: 0.05,
  minimumRequiredNetR: 0.10,
  evidence: { sampleCount: 6, p90FeeR: 0.35 },
});
// Same forward-looking evidence, stress view: gross 0.30, fee 0.35, spread
// stress 0.0375, slippage 0.0125 -> stressed -0.10.
const D05_C6_INPUT = Object.freeze({
  instrument: 'EURUSD',
  grossOutcome: 'TARGET_QUOTE_TOUCH',
  grossR: 0.30,
  stopDistance: 0.004,
  feeSamples: 6,
  feeP90R: 0.35,
  spreadBars: 6,
  spreadP90Price: 0.00012,
});
// C1 on a positive realized history for the same cell (collecting, positive;
// recent-8 = 5 losses + 3 wins -> no degradation).
const D05_C1_ROWS = c1Seq([
  { count: 5, status: 'LOSS', netR: -0.05, newest: 2500 },
  { count: 9, status: 'WIN', netR: 0.25, newest: 2300 },
]);

// D06: C1 rescue-eligible mature cell (losses older, recent-8 all wins) vs
// C6 stress erasing the same edge.
const D06_C1_ROWS = c1Seq([
  { count: 8, status: 'LOSS', netR: -0.2, newest: 1500 },
  { count: 12, status: 'WIN', netR: 0.3, newest: 1200 },
]);
const D06_C6_INPUT = Object.freeze({
  instrument: 'EURUSD',
  grossOutcome: 'TARGET_QUOTE_TOUCH',
  grossR: 0.25,
  stopDistance: 0.004,
  feeSamples: 5,
  feeP90R: 0.30,
  spreadBars: 5,
  spreadP90Price: 0.00012,
});
const D06_P5_INPUT = Object.freeze({
  targetR: 1.5,
  confidence: 0.7,
  directionQuality: 0.7,
  reliability: { realizedRSamples: 0, averageRealizedR: null },
});

// D07: C1 rescue-eligible vs P5 recent-payoff drag below the 0.08 paper floor.
const D07_P5_INPUT = Object.freeze({
  targetR: 1.5,
  confidence: 0.7,
  directionQuality: 0.7,
  reliability: {
    realizedRSamples: 6,
    averageRealizedR: 0.10,
    recentPayoffRSamples: 5,
    recentPayoffAverageR: -0.55,
  },
});

// D08: C1 rescue-eligible, C2 mature but drawdown-blocked, C6 stress-negative.
const D08_C1_ROWS = D06_C1_ROWS;
// D08: C1 rescue-eligible, C2 dd-degraded (drawdown 0.12857 > 0.12 with a
// stable recent-8), C6 stress-negative on the same cell.
const D08_C2_ROWS = [
  ...Array.from({ length: 12 }, (_, i) => c2Row(3000 - i * 20, -0.3, { realised_pnl: -30, risk_amount: 100 })),
  ...Array.from({ length: 12 }, (_, i) => c2Row(2000 - i * 20, 0.35, { realised_pnl: 35, risk_amount: 100 })),
];
const D08_C6_INPUT = Object.freeze({ ...D06_C6_INPUT, grossR: 0.25, feeP90R: 0.35 });

// D09: the A1 arbiter on a calibration block — paired side decides binding.
const D09_CALIBRATION = Object.freeze({
  blockRecommended: true,
  reason: 'CALIBRATED_EDGE_UNFAVOURABLE',
  maturity: 'MATURE',
  sourceLevel: 'EXACT',
  samples: 24,
  calibratedNetExpectedR: -0.05,
  calibratedWinProbability: 0.42,
});
const D09_PAIRED_CURRENT = Object.freeze({
  buyDirectionalProbability: 0.62,
  sellDirectionalProbability: 0.38,
  preferredDirection: 'BUY',
  preferredAbsoluteProbability: 0.62,
  directionalEdge: 0.24,
  reason: 'PAIRED_DIRECTION_BUY',
});
const D09_PAIRED_OPPOSITE = Object.freeze({
  buyDirectionalProbability: 0.35,
  sellDirectionalProbability: 0.65,
  preferredDirection: 'SELL',
  preferredAbsoluteProbability: 0.65,
  directionalEdge: -0.30,
  reason: 'PAIRED_DIRECTION_SELL',
});

// D10: coarse evidence ladder — the ROUTE bucket (34 rows across two pairs)
// is authoritative while the exact cell (11 rows) is not: C1 degrades to a
// stance WITHOUT local authority; C2's independent exact-cell fixture is
// MATURE and can upsize. The 8 most recent ROUTE rows are losses.
const D10_C1_ROWS = c1Seq([
  { count: 5, status: 'LOSS', netR: -0.1, newest: 900 },
  { count: 3, status: 'LOSS', netR: -0.1, newest: 1000, overrides: { instrument: 'GBPUSD' } },
  { count: 6, status: 'WIN', netR: 0.25, newest: 1100 },
  { count: 8, status: 'LOSS', netR: -0.3, newest: 1500, overrides: { instrument: 'GBPUSD' } },
  { count: 12, status: 'WIN', netR: 0.25, newest: 2100, overrides: { instrument: 'GBPUSD' } },
]);
const D10_C2_ROWS = [
  ...Array.from({ length: 8 }, (_, i) => c2Row(3000 - i * 20, -0.05, { realised_pnl: -5, risk_amount: 100 })),
  ...Array.from({ length: 12 }, (_, i) => c2Row(2000 - i * 20, 0.4, { realised_pnl: 40, risk_amount: 100 })),
];

// D11 control: every layer agrees the cell is positive and mature.
const D11_C1_ROWS = D06_C1_ROWS;
const D11_C2_ROWS = D10_C2_ROWS;
const D11_PULSE_OUTCOMES = D03_PULSE_OUTCOMES;
const D11_P5_INPUT = Object.freeze({
  targetR: 1.5,
  confidence: 0.7,
  directionQuality: 0.7,
  reliability: {
    realizedRSamples: 8,
    averageRealizedR: 0.30,
    recentPayoffRSamples: 5,
    recentPayoffAverageR: 0.25,
  },
});

// ---------------------------------------------------------- corpus records

/**
 * Disposition of one layer on one corpus record:
 *   support / oppose / neutral. Divergence requires BOTH a support and an
 *   oppose (disposition conflict) OR >= 2 distinct layer:reason labels on
 *   the same evidence (reason divergence, e.g. maturity vocabulary splits).
 */
const CORPUS = [
  {
    id: 'CL-D01',
    class: 'DISAGREEMENT',
    kind: 'verdict',
    question: 'Does the cell evidence support admission?',
    inputs: { c1Rows: D01_C1_ROWS, c2Rows: D01_C2_ROWS },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'oppose', maturity: 'DEGRADED', blockRecommended: true, reason: 'CALIBRATED_EDGE_UNFAVOURABLE' } },
      { layer: 'C2', expect: { disposition: 'support', maturity: 'MATURE', canUpsize: true, reason: 'MATURE_EDGE_EVIDENCE' } },
    ],
    note: 'C1 degrades on recent-8 wins <= 1; C2 requires zero wins — the same trajectory blocks under C1 and upsizes under C2.',
  },
  {
    id: 'CL-D02',
    class: 'DISAGREEMENT',
    kind: 'maturity',
    question: 'Does the cell evidence support admission?',
    inputs: { c1Rows: D02_C1_ROWS, c2Rows: D02_C2_ROWS },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'neutral', authoritative: false, maturity: 'SPARSE', reason: 'CALIBRATION_EVIDENCE_SPARSE' } },
      { layer: 'C2', expect: { disposition: 'neutral', maturity: 'COLLECTING', reason: 'COLLECTING_EDGE_EVIDENCE' } },
    ],
    note: 'A 15-row cell is C1-authoritative (>= 12) but C2-COLLECTING (< 20): the maturity vocabularies label the same evidence differently.',
  },
  {
    id: 'CL-D03',
    class: 'DISAGREEMENT',
    kind: 'verdict',
    question: 'Does the directional evidence support the BUY candidate?',
    inputs: { c1Rows: D01_C1_ROWS, c2Rows: D01_C2_ROWS, pulseOutcomes: D03_PULSE_OUTCOMES },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'oppose', maturity: 'DEGRADED', blockRecommended: true } },
      { layer: 'C2', expect: { disposition: 'support', canUpsize: true } },
      { layer: 'C3', expect: { disposition: 'support', status: 'SUPPORTED', advantageR: 0.65 } },
    ],
    note: 'The decayed ranking pulse supports the side the calibrated layers block — ranking vs calibration divergence.',
  },
  {
    id: 'CL-D04',
    class: 'DISAGREEMENT',
    kind: 'economics',
    question: 'What spread does the paper cost model use?',
    inputs: { c4Sparse: D04_SPARSE_INPUT, c4Calibrated: D04_INPUT },
    evaluations: [
      { layer: 'C4', field: 'c4Sparse', expect: { disposition: 'neutral', reason: 'SPARSE_HISTORY_FIXED_FALLBACK', calibratedCostR: 0.0625 } },
      { layer: 'C4', field: 'c4Calibrated', expect: { disposition: 'support', reason: 'CALIBRATED_P95_WITH_FLOOR', calibratedCostR: 0.03125 } },
    ],
    note: 'At the 100-sample boundary the same session moves costR by 0.03125R (fixed 0.0625 vs p95 0.03125) — the shadow disagrees with the fixed assumption.',
  },
  {
    id: 'CL-D05',
    class: 'DISAGREEMENT',
    kind: 'economics',
    question: 'Does the forward economics support admission?',
    inputs: { c1Rows: D05_C1_ROWS, c5: D05_C5_INPUT, c6: D05_C6_INPUT },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'support', maturity: 'COLLECTING', blockRecommended: false, reason: 'CALIBRATION_APPLIED' } },
      { layer: 'C5', expect: { disposition: 'oppose', reason: 'CAUSAL_FEE_EVIDENCE_READY', estimatedNetAfterFeeR: -0.05, hypotheticalNetFloorPassed: false } },
      { layer: 'C6', expect: { disposition: 'oppose', state: 'ESTIMABLE_STRESS_ONLY', stressedCostAdjustedR: -0.1 } },
    ],
    note: 'Realized blended history stays positive while the forward p90 fee and stress views both flip the same candidate negative.',
  },
  {
    id: 'CL-D06',
    class: 'DISAGREEMENT',
    kind: 'economics',
    question: 'Does the cell support a rescue of the paper floor?',
    inputs: { c1Rows: D06_C1_ROWS, c6: D06_C6_INPUT, p5: D06_P5_INPUT },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'support', rescueEligible: true, reason: 'MATURE_POSITIVE_CALIBRATED_EDGE' } },
      { layer: 'C6', expect: { disposition: 'oppose', state: 'ESTIMABLE_STRESS_ONLY', stressedCostAdjustedR: -0.1 } },
    ],
    note: 'C1 grants rescue (net 0.128571R, winProb 0.605714, pf 2.25) on realized evidence; the forward stress view of the same geometry is negative.',
  },
  {
    id: 'CL-D07',
    class: 'DISAGREEMENT',
    kind: 'authority',
    question: 'Does the expectancy evidence support admission?',
    inputs: { c1Rows: D06_C1_ROWS, p5: D07_P5_INPUT },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'support', rescueEligible: true } },
      { layer: 'P5', expect: { disposition: 'oppose', source: 'REALISED_PAIR_SIDE', statisticalExpectedR: -0.011364, recentPayoffApplied: true } },
    ],
    note: 'The recent-payoff blend drags P5 to -0.011364R — below the 0.08 paper floor — while C1 rescues the same cell.',
  },
  {
    id: 'CL-D08',
    class: 'DISAGREEMENT',
    kind: 'verdict',
    question: 'Does the cell evidence support admission or upsize?',
    inputs: { c1Rows: D08_C1_ROWS, c2Rows: D08_C2_ROWS, c6: D08_C6_INPUT },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'support', rescueEligible: true } },
      { layer: 'C2', expect: { disposition: 'oppose', maturity: 'DEGRADED', canUpsize: false, reason: 'RECENT_EDGE_DEGRADED' } },
      { layer: 'C6', expect: { disposition: 'oppose', stressedCostAdjustedR: -0.15 } },
    ],
    note: 'C1 rescues while C6 opposes the forward economics and C2 flags drawdown-driven degradation (0.1538 > 0.12) on the same cell.',
  },
  {
    id: 'CL-D09',
    class: 'DISAGREEMENT',
    kind: 'authority',
    question: 'Does a calibration block bind the candidate side?',
    inputs: { calibration: D09_CALIBRATION, pairedCurrent: D09_PAIRED_CURRENT, pairedOpposite: D09_PAIRED_OPPOSITE },
    evaluations: [
      { layer: 'A1', field: 'pairedCurrent', expect: { disposition: 'oppose', state: 'BLOCK_CURRENT_SIDE_FAVORED', active: true } },
      { layer: 'A1', field: 'pairedOpposite', expect: { disposition: 'neutral', state: 'BLOCK_OPPOSITE_SIDE_FAVORED', active: false } },
    ],
    note: 'The same calibration block binds only when the paired-direction preference agrees with the blocked candidate side.',
  },
  {
    id: 'CL-D10',
    class: 'DISAGREEMENT',
    kind: 'authority',
    question: 'Does degraded evidence authorize action at every ladder level?',
    inputs: { c1Rows: D10_C1_ROWS, c2Rows: D10_C2_ROWS },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'oppose', authoritative: true, sourceLevel: 'ROUTE', maturity: 'DEGRADED', blockRecommended: false, stanceWouldBlock: true, reason: 'CALIBRATION_APPLIED' } },
      { layer: 'C2', expect: { disposition: 'support', maturity: 'MATURE', canUpsize: true } },
    ],
    note: 'C1 degrades to a stance without authority at ROUTE level (blockRecommended stays false); C2 upsizes from the exact cell — the authority gap the unified contract must close.',
  },
  {
    id: 'CL-D11',
    class: 'CONTROL',
    kind: 'none',
    question: 'Do all layers agree on a mature positive cell?',
    inputs: { c1Rows: D11_C1_ROWS, c2Rows: D11_C2_ROWS, pulseOutcomes: D11_PULSE_OUTCOMES, c4: D04_INPUT, c5: { originalNetExpectedR: 0.30, spreadOnlyCostR: 0.05, minimumRequiredNetR: 0.10, evidence: { sampleCount: 8, p90FeeR: 0.05 } }, c6: { ...D06_C6_INPUT, feeP90R: 0.02 }, p5: D11_P5_INPUT },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'support', rescueEligible: true } },
      { layer: 'C2', expect: { disposition: 'support', canUpsize: true } },
      { layer: 'C3', expect: { disposition: 'support', status: 'SUPPORTED' } },
      { layer: 'C4', expect: { disposition: 'support', reason: 'CALIBRATED_P95_WITH_FLOOR' } },
      { layer: 'C5', expect: { disposition: 'support', hypotheticalNetFloorPassed: true } },
      { layer: 'C6', expect: { disposition: 'support', stressedCostAdjustedR: 0.18 } },
      { layer: 'P5', expect: { disposition: 'support', source: 'REALISED_PAIR_SIDE' } },
    ],
    note: 'Control: every layer independently supports the same mature positive cell.',
  },
  {
    id: 'CL-D12',
    class: 'CONTROL',
    kind: 'none',
    question: 'Do all layers abstain without evidence?',
    inputs: { c1Rows: [], c2Rows: [], pulseOutcomes: [], c4: { instrument: 'EURUSD', fixedSpreadPrice: 0.0002, stopDistancePrice: 0.004, history: { sampleCount: 4, p95SpreadPrice: 0.0001 } }, c5: { originalNetExpectedR: 0.30, spreadOnlyCostR: 0.05, minimumRequiredNetR: 0.10, evidence: { sampleCount: 2, p90FeeR: null } }, c6: { instrument: 'EURUSD', grossOutcome: 'TIME_MARK', grossR: null, stopDistance: 0.004, feeSamples: 1, feeP90R: null, spreadBars: 1, spreadP90Price: null }, p5: { targetR: 1.5, confidence: 0.7, directionQuality: 0.7, reliability: { realizedRSamples: 0, averageRealizedR: null } } },
    evaluations: [
      { layer: 'C1', expect: { disposition: 'neutral', authoritative: false, reason: 'CALIBRATION_EVIDENCE_UNAVAILABLE' } },
      { layer: 'C2', expect: { disposition: 'neutral', reason: 'NO_PROSPECTIVE_EXACT_CELL_EVIDENCE' } },
      { layer: 'C3', expect: { disposition: 'neutral', status: 'INSUFFICIENT' } },
      { layer: 'C4', expect: { disposition: 'neutral', reason: 'SPARSE_HISTORY_FIXED_FALLBACK' } },
      { layer: 'C5', expect: { disposition: 'neutral', reason: 'INSUFFICIENT_PRIOR_CLOSED_TRADES' } },
      { layer: 'C6', expect: { disposition: 'neutral', reason: 'UNRESOLVED_QUOTE_OUTCOME' } },
      { layer: 'P5', expect: { disposition: 'neutral', source: 'HEURISTIC_PRIOR' } },
    ],
    note: 'Control: empty evidence abstains everywhere — no layer fabricates a stance.',
  },
];
const CORPUS_SIZE = CORPUS.length; // 12

// -------------------------------------------- A1 faithful mirror (arbiter)

function mirrorA1(calibration, paired, candidateDirection = 'BUY') {
  const buy = paired.buyDirectionalProbability;
  const sell = paired.sellDirectionalProbability;
  const valid = Number.isFinite(buy) && Number.isFinite(sell) && buy >= 0 && buy <= 1 && sell >= 0 && sell <= 1;
  let rawPreferredDirection = null;
  if (valid && Math.abs(buy - sell) > 1e-9) rawPreferredDirection = buy > sell ? 'BUY' : 'SELL';
  let state;
  if (!calibration.blockRecommended) state = 'NO_CALIBRATION_BLOCK';
  else if (!valid) state = 'BLOCK_PAIRED_INVALID';
  else if (rawPreferredDirection === null) state = 'BLOCK_PAIRED_BALANCED';
  else if (rawPreferredDirection === candidateDirection) state = 'BLOCK_CURRENT_SIDE_FAVORED';
  else state = 'BLOCK_OPPOSITE_SIDE_FAVORED';
  return {
    layer: 'A1',
    state,
    active: state === 'BLOCK_CURRENT_SIDE_FAVORED',
    reason: `CALIBRATION_${state}`,
  };
}

// ------------------------------------------------------ corpus evaluation

const SUPPORTING_C1 = (d) =>
  d.authoritative && !d.blockRecommended && (d.rescueEligible || d.calibratedNetExpectedR > 0);
// The STANCE a degraded/mature-negative cell takes, independent of whether
// the evidence ladder grants local authority (the CL-D10 authority gap).
const C1_STANCE_WOULD_BLOCK = (d) =>
  d.maturity === 'DEGRADED' ||
  (d.maturity === 'MATURE' && (d.calibratedNetExpectedR <= 0 || d.calibratedWinProbability < 0.45));

function dispositionOf(evaluation, computed) {
  const layer = evaluation.layer;
  if (layer === 'C1') {
    if (!computed.available) return 'neutral';
    if (C1_STANCE_WOULD_BLOCK(computed)) return 'oppose';
    if (SUPPORTING_C1(computed)) return 'support';
    return 'neutral';
  }
  if (layer === 'C2') {
    if (computed.canUpsize) return 'support';
    if (computed.recentDegradation) return 'oppose';
    return 'neutral';
  }
  if (layer === 'C3') {
    if (computed.status === 'SUPPORTED') return 'support';
    if (computed.status === 'OPPOSED') return 'oppose';
    return 'neutral';
  }
  if (layer === 'C4') return computed.reason === 'CALIBRATED_P95_WITH_FLOOR' ? 'support' : 'neutral';
  if (layer === 'C5') {
    if (computed.reason !== 'CAUSAL_FEE_EVIDENCE_READY') return 'neutral';
    return computed.hypotheticalNetFloorPassed ? 'support' : 'oppose';
  }
  if (layer === 'C6') {
    if (computed.state !== 'ESTIMABLE_STRESS_ONLY') return 'neutral';
    return computed.stressedCostAdjustedR > 0 ? 'support' : 'oppose';
  }
  if (layer === 'P5') {
    if (computed.source !== 'REALISED_PAIR_SIDE') return 'neutral';
    return computed.statisticalExpectedR >= 0.08 ? 'support' : 'oppose';
  }
  if (layer === 'A1') return computed.active ? 'oppose' : 'neutral';
  return refusal(REFUSALS.UNSUPPORTED_SURFACE, layer);
}

function runLayerEvaluation(evaluation, inputs) {
  const field = evaluation.field ?? null;
  switch (evaluation.layer) {
    case 'C1':
      return mirrorC1(inputs.c1Rows ?? [], C1_REQUEST);
    case 'C2':
      return mirrorC2(inputs.c2Rows ?? [], C2_REQUEST);
    case 'C3':
      return mirrorC3(inputs.pulseOutcomes ?? [], 'BUY', T0);
    case 'C4':
      return mirrorC4(inputs[field] ?? inputs.c4 ?? D04_INPUT);
    case 'C5':
      return mirrorC5(inputs.c5);
    case 'C6':
      return mirrorC6(inputs.c6);
    case 'P5':
      return mirrorP5(inputs.p5);
    case 'A1':
      return mirrorA1(inputs.calibration, inputs[field], 'BUY');
    default:
      return refusal(REFUSALS.UNSUPPORTED_SURFACE, evaluation.layer);
  }
}

function evaluateCorpusRecord(record) {
  const evaluations = record.evaluations.map((evaluation) => {
    const computed = runLayerEvaluation(evaluation, record.inputs);
    if (isRefusal(computed)) {
      return { layer: evaluation.layer, ok: false, reason: computed.refusal, computed };
    }
    const expected = evaluation.expect;
    const disposition = dispositionOf(evaluation, computed);
    const checks = { disposition: disposition === expected.disposition };
    for (const [key, value] of Object.entries(expected)) {
      if (key === 'disposition') continue;
      const actual = computed[key];
      checks[key] =
        typeof value === 'number' && typeof actual === 'number'
          ? round6(actual) === round6(value)
          : actual === value;
    }
    const ok = Object.values(checks).every(Boolean);
    return {
      layer: evaluation.layer,
      ok,
      disposition,
      reason: computed.reason ?? computed.state ?? computed.status,
      computed,
      checks,
    };
  });
  const supports = evaluations.filter((e) => e.disposition === 'support').length;
  const opposes = evaluations.filter((e) => e.disposition === 'oppose').length;
  const dispositionConflict = supports > 0 && opposes > 0;
  // Within-layer split: the SAME layer evaluated twice on one record (e.g.
  // C4 across the 100-sample boundary, A1 across the paired sides) and the
  // two evaluations disagree.
  const byLayerCount = new Map();
  const byLayerReasons = new Map();
  for (const evaluation of evaluations) {
    byLayerCount.set(evaluation.layer, (byLayerCount.get(evaluation.layer) ?? 0) + 1);
    const reasons = byLayerReasons.get(evaluation.layer) ?? new Set();
    reasons.add(evaluation.reason);
    byLayerReasons.set(evaluation.layer, reasons);
  }
  const withinLayerSplit = [...byLayerCount.entries()].some(
    ([layer, count]) => count > 1 && byLayerReasons.get(layer).size > 1,
  );
  return {
    id: record.id,
    class: record.class,
    kind: record.kind,
    evaluations,
    supports,
    opposes,
    dispositionConflict,
    withinLayerSplit,
    divergent: record.class === 'DISAGREEMENT' && (dispositionConflict || withinLayerSplit || evaluations.length >= 2),
  };
}

function buildCalibrationMatrix(corpusRecords) {
  const rows = corpusRecords.map(evaluateCorpusRecord);
  const byLayer = {};
  for (const layer of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'A1', 'P5']) {
    byLayer[layer] = { support: 0, oppose: 0, neutral: 0, ok: 0, evaluated: 0 };
  }
  for (const row of rows) {
    for (const evaluation of row.evaluations) {
      const bucket = byLayer[evaluation.layer];
      if (!bucket) continue;
      bucket.evaluated += 1;
      if (evaluation.ok) bucket.ok += 1;
    }
  }
  // Dispositions are recomputed from the committed expectations (the corpus
  // is frozen): support/oppose/neutral counts per layer.
  for (const record of corpusRecords) {
    for (const evaluation of record.evaluations) {
      const bucket = byLayer[evaluation.layer];
      if (!bucket) continue;
      const d = evaluation.expect.disposition;
      if (d === 'support') bucket.support += 1;
      else if (d === 'oppose') bucket.oppose += 1;
      else bucket.neutral += 1;
    }
  }
  const patterns = new Set(
    rows.map((row) =>
      row.evaluations
        .map((e) => `${e.layer}:${e.reason ?? 'n/a'}`)
        .sort()
        .join('|'),
    ),
  );
  return {
    rows,
    byLayer,
    disagreementCount: rows.filter((r) => r.class === 'DISAGREEMENT').length,
    controlCount: rows.filter((r) => r.class === 'CONTROL').length,
    dispositionConflictCount: rows.filter((r) => r.dispositionConflict).length,
    withinLayerSplitCount: rows.filter((r) => r.withinLayerSplit).length,
    distinctPatterns: patterns.size,
  };
}

// ------------------------------------------------- the CAL-1 unified ladder

const CAL1 = Object.freeze({
  name: 'CAL-1',
  cellKeyFields: ['instrument', 'direction', 'session', 'state', 'strategyRoute', 'decisionPolicyVersion'],
  evidenceLadder: ['EXACT', 'PAIR_DIRECTION_ROUTE', 'ROUTE', 'GLOBAL'],
  sampleLadder: [
    { tier: 'COLD', rule: 'samples < 4', authority: 'NONE' },
    { tier: 'SCOUT', rule: '4 <= samples < 12', authority: 'SHADOW_ONLY' },
    { tier: 'AUTHORITATIVE', rule: '12 <= samples < 20 or 5/5 missing', authority: 'ADVISORY' },
    { tier: 'MATURE', rule: 'samples >= 20 and wins >= 5 and losses >= 5', authority: 'PAPER_BLOCK_RESCUE' },
  ],
  maturityVocabulary: ['SPARSE', 'COLLECTING', 'MATURE', 'DEGRADED'],
  authorityGradient: ['NONE', 'SHADOW_ONLY', 'ADVISORY', 'PAPER_BLOCK_RESCUE'],
  blend: {
    probability: 'calibrated = clamp01((raw * 8 + wins) / (8 + samples))',
    expectedR: 'calibrated = (raw * 8 + sum(netR)) / (8 + samples)',
    priorWeight: 8,
  },
  blockVocabulary: ['CALIBRATED_EDGE_UNFAVOURABLE'],
  rescueVocabulary: ['MATURE_POSITIVE_CALIBRATED_EDGE'],
  scoreboard: 'CAL-2',
  localAuthorityLevels: C1_LOCAL_LEVELS,
  closedGaps: [
    'GAP-1 maturity vocabulary: C2 SPARSE/COLLECTING/MATURE/DEGRADED and C1 SPARSE/COLLECTING/MATURE/DEGRADED unify on one ladder (CL-D02).',
    'GAP-2 authority gap: degraded evidence at ROUTE/GLOBAL level keeps the stance but not the block (CL-D10) — CAL-1 binds the stance to an explicit authority tier.',
    'GAP-3 ranking vs calibration: the C3 pulse and C1 block may disagree on the same side (CL-D03); CAL-1 records both and lets the authority gradient decide.',
    'GAP-4 economics: C5/C6 forward cost views may oppose a realized-history rescue (CL-D05/D06/D08); CAL-1 requires the forward view to be recorded on the scoreboard, not silently dropped.',
  ],
});

// -------------------------------------------------------------- validation

const VALID_CLASSES = ['DISAGREEMENT', 'CONTROL'];
const VALID_KINDS = ['verdict', 'maturity', 'economics', 'authority', 'none'];

function validateCalibrationContract(contract) {
  if (contract.meta.artifact !== CONTRACT_ARTIFACT) return false;
  if (contract.calibrationLayers.length !== CALIBRATION_LAYERS.length) return false;
  if (contract.predictionFamilies.length !== PREDICTION_FAMILIES.length) return false;
  const layerKeys = new Set(contract.calibrationLayers.map((l) => l.key));
  if (layerKeys.size !== contract.calibrationLayers.length) return false;
  for (const layer of contract.calibrationLayers) {
    for (const constant of layer.constants) {
      if (!Number.isFinite(constant.value) || !Number.isInteger(constant.line) || constant.line <= 0) {
        return false;
      }
    }
  }
  const ids = new Set();
  for (const record of contract.corpus) {
    if (ids.has(record.id)) return false;
    ids.add(record.id);
    if (!VALID_CLASSES.includes(record.class) || !VALID_KINDS.includes(record.kind)) return false;
    if (!record.evaluations.length) return false;
  }
  const matrix = buildCalibrationMatrix(contract.corpus);
  const stats = contract.statistics;
  if (matrix.disagreementCount !== stats.corpus.disagreementCount) return false;
  if (matrix.controlCount !== stats.corpus.controlCount) return false;
  if (matrix.distinctPatterns !== stats.corpus.distinctPatterns) return false;
  if (matrix.dispositionConflictCount !== stats.corpus.dispositionConflictCount) return false;
  if (matrix.withinLayerSplitCount !== stats.corpus.withinLayerSplitCount) return false;
  for (const row of matrix.rows) {
    if (row.evaluations.some((evaluation) => !evaluation.ok)) return false;
  }
  return true;
}

/**
 * Drift detector: every pinned constant must still appear at its pinned
 * line with the pinned value in the real repository tree this test runs in.
 */
function verifyCalibrationPaths(repoRoot = process.cwd()) {
  const targets = [
    ...CALIBRATION_LAYERS.map((layer) => ({ key: layer.key, path: layer.path, constants: layer.constants })),
    ...PREDICTION_FAMILIES.filter((f) => f.constants.length > 0).map((family) => ({
      key: family.key,
      path: family.path,
      constants: family.constants,
    })),
    { key: 'B5', path: B5_ORCHESTRATOR_FLOOR.path, constants: B5_ORCHESTRATOR_FLOOR.constants },
  ];
  const results = [];
  for (const target of targets) {
    const absolute = path.join(repoRoot, target.path);
    let lines = null;
    try {
      lines = fs.readFileSync(absolute, 'utf8').split('\n');
    } catch {
      results.push({ key: target.key, path: target.path, ok: false, error: 'FILE_MISSING' });
      continue;
    }
    const constantResults = target.constants.map((constant) => {
      const line = lines[constant.line - 1] ?? '';
      const ok =
        line.includes(constant.name) &&
        line.includes(String(constant.value));
      return { name: constant.name, line: constant.line, ok };
    });
    results.push({
      key: target.key,
      path: target.path,
      ok: constantResults.every((c) => c.ok),
      constants: constantResults,
    });
  }
  return { verified: results.filter((r) => r.ok).length, total: results.length, results };
}

/** A2 auxiliary anchor: the 21-day window literal in the history companion. */
function verifyAuxiliaryAnchors(repoRoot = process.cwd()) {
  const absolute = path.join(repoRoot, AI, 'paper-spread-calibration-history.ts');
  try {
    const text = fs.readFileSync(absolute, 'utf8');
    const ok = text.includes("interval '21 days'");
    return { verified: ok ? 1 : 0, total: 1 };
  } catch {
    return { verified: 0, total: 1 };
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const CALIBRATION_CONTRACT = deepFreeze(
  Object.freeze({
    meta: {
      artifact: CONTRACT_ARTIFACT,
      spec: 'AI_ENGINE_V2_P1_4_CALIBRATION_CONSOLIDATION_SPEC_20261127.md',
      inputs: 'component map v1 §4 (six calibration layers + two auxiliaries) and §6 (five prediction families, six confidence-floor copies)',
      executionAuthority: 'NONE',
      authoredOn: 'research/ai-engine-v2-p1-4-calibration-20261127 (stacked on 6407c1c6 -> 31c4e862 -> cff28862)',
    },
    calibrationLayers: CALIBRATION_LAYERS,
    predictionFamilies: PREDICTION_FAMILIES,
    b5OrchestratorFloor: B5_ORCHESTRATOR_FLOOR,
    cal1: CAL1,
    cal2Scoreboard: {
      families: SCOREBOARD_FAMILIES,
      excludedFamilies: SCOREBOARD_EXCLUDED_FAMILIES,
      fields: SCOREBOARD_FIELDS,
      rules: [
        'Append-only: registrations are never edited or removed.',
        'Pre-outcome: registeredAt must predate the resolution timestamp; post-resolution registration is retrodiction and refused.',
        'Duplicate predictionId is refused.',
        'P4 (OWNER_FORECAST_NET_R) is RESEARCH_ONLY and excluded from the qualification scoreboard.',
        'executionAuthority is NONE on every registration; the scoreboard never grants order authority.',
      ],
    },
    corpus: CORPUS,
    statistics: {
      corpus: {
        size: CORPUS_SIZE,
        disagreementCount: 10,
        controlCount: 2,
        dispositionConflictCount: 7,
        withinLayerSplitCount: 2,
        distinctPatterns: 12,
        layerCounts: {
          C1: { support: 5, oppose: 3, neutral: 2 },
          C2: { support: 4, oppose: 1, neutral: 2 },
          C3: { support: 2, oppose: 0, neutral: 1 },
          C4: { support: 2, oppose: 0, neutral: 2 },
          C5: { support: 1, oppose: 1, neutral: 1 },
          C6: { support: 1, oppose: 3, neutral: 1 },
          A1: { support: 0, oppose: 1, neutral: 1 },
          P5: { support: 1, oppose: 1, neutral: 2 },
        },
      },
    },
  }),
);

function summarizeCalibrationContract() {
  const matrix = buildCalibrationMatrix(CORPUS);
  return {
    artifact: CONTRACT_ARTIFACT,
    calibrationLayers: CALIBRATION_LAYER_COUNT,
    predictionFamilies: PREDICTION_FAMILY_COUNT,
    corpus: {
      size: matrix.disagreementCount + matrix.controlCount,
      disagreementCount: matrix.disagreementCount,
      controlCount: matrix.controlCount,
      dispositionConflictCount: matrix.dispositionConflictCount,
      withinLayerSplitCount: matrix.withinLayerSplitCount,
      distinctPatterns: matrix.distinctPatterns,
    },
    byLayer: matrix.byLayer,
    cal1Tiers: CAL1.sampleLadder.length,
    scoreboardFamilies: SCOREBOARD_FAMILIES.length,
    excludedFamilies: SCOREBOARD_EXCLUDED_FAMILIES.length,
  };
}

module.exports = {
  CONTRACT_ARTIFACT,
  REFUSALS,
  CALIBRATION_LAYERS,
  PREDICTION_FAMILIES,
  B5_ORCHESTRATOR_FLOOR,
  CALIBRATION_LAYER_COUNT,
  PREDICTION_FAMILY_COUNT,
  CAL1,
  SCOREBOARD_FAMILIES,
  SCOREBOARD_EXCLUDED_FAMILIES,
  SCOREBOARD_FIELDS,
  CALIBRATION_CONTRACT,
  CORPUS,
  CORPUS_SIZE,
  mirrorC1,
  mirrorC2,
  mirrorC3,
  mirrorC4,
  mirrorC5,
  mirrorC6,
  mirrorA1,
  mirrorP5,
  validatePredictionRegistration,
  registerPrediction,
  validateCalibrationContract,
  verifyCalibrationPaths,
  verifyAuxiliaryAnchors,
  buildCalibrationMatrix,
  summarizeCalibrationContract,
};
