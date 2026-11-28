'use strict';
/**
 * V2 direction-scorer contract — the machine-readable mirror of backlog item
 * P1-1 (`docs/research/AI_ENGINE_V2_P1_1_DIRECTION_SCORER_UNIFICATION_SPEC_20261127.md`).
 *
 * Contents: (a) the verified inventory of the four V1 direction scorers —
 * columns, units, weight groups with line references, thresholds, and the
 * four divergent missing-value rules; (b) the unified V2 contract DS-1 —
 * one column set, one unit per concept, one missing-value rule, one output
 * semantics; (c) the DS-1 application surface with typed refusals.
 *
 * Research-only: this module grants no order authority, imports no runtime
 * path, and changes no runtime behavior (`executionAuthority: NONE`).
 * `verifyScorerPaths()` is the drift detector — CI re-proves on every run
 * that each mapped scorer source still exists; `validateDirectionScorerContract()`
 * re-proves the weight sums and the divergence count so the inventory
 * cannot silently drift from the spec document.
 *
 * Typed refusals raised by this module:
 *   CONTRACT_INPUT_REQUIRED, CONTRACT_META_INCOMPLETE, CONTRACT_COUNT_MISMATCH,
 *   CONTRACT_DUPLICATE_KEY, CONTRACT_MISSING_FIELD, CONTRACT_COLUMN_MALFORMED,
 *   CONTRACT_WEIGHT_MALFORMED, CONTRACT_WEIGHT_SUM_MISMATCH,
 *   CONTRACT_UNKNOWN_UNIT, CONTRACT_UNKNOWN_GROUP, CONTRACT_SCORER_PATH_NOT_FOUND
 * and, from applyDirectionScorerContract():
 *   SCORER_INPUT_REQUIRED, SCORER_UNSUPPORTED_INSTRUMENT, SCORER_INPUT_OUT_OF_RANGE.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_ARTIFACT = 'v2-direction-scorer-contract-v1';

const AI = 'apps/api/src/modules/ai';

const SUPPORTED_INSTRUMENTS = Object.freeze([
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF',
]);

const MISSING_VALUE_RULES = Object.freeze([
  // S1: optional M5/M30 fields default to 0 via ?? (ratio fields to 1); the
  // clamps do not guard NaN, so NaN propagates into directionQuality.
  'SILENT_DEFAULT',
  // S2: shortHorizonMomentumAtr non-finite -> 0 (the only guarded field);
  // every other field propagates NaN through clamp01.
  'PARTIAL_DEFAULT_NAN_PROPAGATES',
  // S3: finite() throws on any non-finite required input (strictest, untyped crash).
  'THROW_ON_NON_FINITE',
  // S4: clamp01 returns 0 on non-finite; undefined optional fields become
  // neutral constants (0.5 / 0.4).
  'ZERO_OR_NEUTRAL_ON_MISSING',
]);

const DS1_UNITS = Object.freeze([
  'enum:6-majors',
  'enum:BUY|SELL',
  'ISO-8601-UTC',
  'string',
  'ATR-signed',
  'ATR-per-bar-signed',
  'ATR-unsigned',
  'signed:[-1,1]',
  'fraction:[0,1]',
  'count:integer',
  'ratio-unsigned:neutral-1',
  'raw:[0,100]',
  'price-units',
  'R-units',
]);

const DS1_GROUPS = Object.freeze([
  'identity', 'structure', 'momentum', 'micro', 'macro', 'oscillator',
  'regime', 'geometry', 'efficiency', 'cost',
]);

const ds1Column = (name, group, unit, required) =>
  ({ name, group, unit, required });

const DS1_COLUMNS = [
  ds1Column('instrument', 'identity', 'enum:6-majors', true),
  ds1Column('direction', 'identity', 'enum:BUY|SELL', true),
  ds1Column('decisionTime', 'identity', 'ISO-8601-UTC', true),
  ds1Column('policyVersion', 'identity', 'string', true),
  ds1Column('emaSeparationAtr', 'structure', 'ATR-signed', true),
  ds1Column('emaSlopeAtr', 'structure', 'ATR-per-bar-signed', true),
  ds1Column('momentum1Atr', 'momentum', 'ATR-signed', true),
  ds1Column('momentum3Atr', 'momentum', 'ATR-signed', true),
  ds1Column('momentum5Atr', 'momentum', 'ATR-signed', true),
  ds1Column('m5Momentum1Atr', 'momentum', 'ATR-signed', true),
  ds1Column('m5Momentum3Atr', 'momentum', 'ATR-signed', true),
  ds1Column('m5BodyPressure3', 'micro', 'signed:[-1,1]', true),
  ds1Column('m5LatestBodyPressure', 'micro', 'signed:[-1,1]', false),
  ds1Column('m5DirectionalRun', 'micro', 'count:integer', false),
  ds1Column('m5BodyExpansionRatio', 'micro', 'ratio-unsigned:neutral-1', false),
  ds1Column('m30DirectionalEfficiency', 'macro', 'signed:[-1,1]', false),
  ds1Column('m30MomentumAtr', 'macro', 'ATR-signed', false),
  ds1Column('higherTimeframeAgreement', 'macro', 'signed:[-1,1]', true),
  ds1Column('alignment.m5', 'macro', 'signed:[-1,1]', true),
  ds1Column('alignment.m15', 'macro', 'signed:[-1,1]', true),
  ds1Column('alignment.h1', 'macro', 'signed:[-1,1]', true),
  ds1Column('alignment.h4', 'macro', 'signed:[-1,1]', true),
  ds1Column('closeLocation', 'micro', 'fraction:[0,1]', true),
  ds1Column('lowerWickRatio', 'micro', 'fraction:[0,1]', true),
  ds1Column('upperWickRatio', 'micro', 'fraction:[0,1]', true),
  ds1Column('breakoutAtr', 'micro', 'ATR-signed', true),
  ds1Column('rsi14', 'oscillator', 'raw:[0,100]', true),
  ds1Column('extensionAtr', 'regime', 'ATR-unsigned', true),
  ds1Column('volatilityScore', 'regime', 'fraction:[0,1]', true),
  ds1Column('atr14', 'geometry', 'price-units', true),
  ds1Column('price', 'geometry', 'price-units', true),
  ds1Column('efficiency5', 'efficiency', 'fraction:[0,1]', true),
  ds1Column('estimatedExecutionCostR', 'cost', 'R-units', true),
];

const DS1_OUTPUT_FIELDS = Object.freeze([
  { name: 'rawScore', semantics: 'uncalibrated model output, recorded for audit' },
  { name: 'probability', semantics: 'calibrated p(direction aligned) from a WS2.1 calibrator bundle (#839 format, hash-pinned)' },
  { name: 'calibrationState', semantics: 'UNCALIBRATED | CALIBRATED; CALIBRATED only from >=100 recorded holdout records' },
  { name: 'inputsUsed', semantics: 'exact consumed column subset with presence flags' },
  { name: 'registration', semantics: 'pre-outcome prediction registration to the V2-7 scoreboard (P1-4)' },
  { name: 'executionAuthority', semantics: 'NONE — research contract; admission is a separate layer' },
]);

const DS1_REFUSALS = Object.freeze([
  'SCORER_INPUT_REQUIRED',
  'SCORER_UNSUPPORTED_INSTRUMENT',
  'SCORER_INPUT_OUT_OF_RANGE',
]);

const w = (name, value, line) => ({ name, value, line });

// ------------------------------------------------------- the four scorers

const SCORERS = [
  {
    key: 'scorer.s1-m1-tactical',
    path: `${AI}/m1-tactical-candidate.ts`,
    artifact: 'M1_TACTICAL_POLICY_V1',
    dialect: 'signed ATR columns, direction alignment applied in the candidate builder',
    missingValueRule: 'SILENT_DEFAULT',
    missingValueEvidence: '?? 0 for optional M5/M30 fields (l.126-129); ?? 1 for m5BodyExpansionRatio (l.130); clamp01/clampSigned do not guard NaN',
    columns: [
      'emaSeparationAtr', 'emaSlopeAtr', 'momentum1Atr', 'momentum3Atr', 'momentum5Atr',
      'm5BodyPressure3', 'm5Momentum1Atr', 'm5Momentum3Atr', 'm5LatestBodyPressure?',
      'm5DirectionalRun?', 'm30DirectionalEfficiency?', 'm30MomentumAtr?',
      'm5BodyExpansionRatio?', 'higherTimeframeAgreement', 'alignment.m5/.m15/.h1/.h4',
      'breakoutUpAtr/breakoutDownAtr', 'closeLocation', 'lowerWickRatio', 'upperWickRatio',
      'rsi14', 'efficiency5', 'volatilityScore',
    ],
    weightGroups: [
      {
        name: 'directionalComposite',
        formula: 'clamp01(0.5 + clampSigned(sum)/2)',
        sum: 1,
        weights: [
          w('emaSeparationAtr', 0.19, 146), w('emaSlopeAtr', 0.1, 147),
          w('momentum3Atr', 0.16, 148), w('momentum5Atr', 0.1, 149),
          w('higherTimeframeAgreement', 0.2, 150), w('closePressure', 0.08, 151),
          w('wickPressure', 0.05, 152), w('rsiBias', 0.04, 153),
          w('breakoutAtr', 0.08, 154),
        ],
      },
      {
        name: 'score',
        formula: 'dq + 0.15*confidence + 0.05*momentum1Atr + 0.05*htfAgreement',
        sum: null,
        weights: [
          w('directionQuality', 1, 163), w('confidence', 0.15, 165),
          w('momentum1Atr', 0.05, 166), w('htfAgreement', 0.05, 167),
        ],
      },
    ],
    thresholds: [
      w('maxConfidence', 0.738, 27), w('minReversalQuality', 0.6, 32),
      w('minReversalImpulseAtr', 0.25, 33),
    ],
    notes: 'confidence = min(0.738, clamp01(0.5 + 0.3*dq + 0.08*efficiency5 - 0.08*volatilityScore)) at l.157-161 (audit B1); confidence is an OUTPUT here and an input to score.',
  },
  {
    key: 'scorer.s2-plan-b-multimodel-shadow',
    path: `${AI}/plan-b-multimodel-shadow.ts`,
    artifact: 'PLAN_B_ENSEMBLE_ARTIFACT',
    dialect: '[0,1]-clamped columns; confidence consumed as an upstream INPUT (floor 0.64)',
    missingValueRule: 'PARTIAL_DEFAULT_NAN_PROPAGATES',
    missingValueEvidence: 'Number.isFinite(shortHorizonMomentumAtr) ? v : 0 at l.135-137; clamp01 (l.111-113) does not guard NaN for the other fields',
    columns: [
      'confidence (input)', 'emaSeparation', 'mtfStrength', 'rsi14', 'extensionAtr',
      'volatilityScore', 'shortHorizonMomentumAtr?', 'scanTime', 'direction', 'instrument',
    ],
    weightGroups: [
      {
        name: 'directionQuality.trend',
        formula: 'clamp01(0.42*clamp01((conf-0.6)/0.2) + 0.25*clamp01(emaSeparation) + 0.23*clamp01(mtfStrength) + 0.10*rsiDirectional)',
        sum: 1,
        weights: [
          w('confidence', 0.42, 128), w('emaSeparation', 0.25, 129),
          w('mtfStrength', 0.23, 130), w('rsiDirectional', 0.1, 131),
        ],
      },
      {
        name: 'directionQuality.reversal',
        formula: 'clamp01(0.45*momentumQuality + 0.20*conf + 0.20*rsi + 0.15*transitionQuality)',
        sum: 1,
        weights: [
          w('momentumQuality', 0.45, 233), w('confidenceQuality', 0.2, 234),
          w('rsiDirectional', 0.2, 235), w('transitionQuality', 0.15, 236),
        ],
      },
      {
        name: 'directionQuality.earlyTransition',
        formula: 'clamp01(0.60*structure + 0.25*rsi + 0.10*conf + 0.05*momentum)',
        sum: 1,
        weights: [
          w('structureQuality', 0.6, 189), w('rsiDirectional', 0.25, 190),
          w('confidenceQuality', 0.1, 191), w('momentumQuality', 0.05, 192),
        ],
      },
      {
        name: 'ensembleScore',
        formula: 'clamp01(0.22*p + 0.15*dir + 0.12*qual + 0.11*exit + 0.10*pairSide + 0.08*session + 0.10*econ + 0.12*portfolio)',
        sum: 1,
        weights: [
          w('meta.probability', 0.22, 402), w('direction', 0.15, 403),
          w('tradeQuality', 0.12, 404), w('exitQuality', 0.11, 405),
          w('pairSideQuality', 0.1, 406), w('sessionQuality', 0.08, 407),
          w('economicQuality', 0.1, 408), w('portfolio.quality', 0.12, 409),
        ],
      },
    ],
    thresholds: [
      w('PLAN_B_CANDIDATE_CONFIDENCE_FLOOR', 0.64, 50),
      w('PLAN_B_GROSS_EXPECTED_R_FLOOR', 0.08, 51),
      w('PLAN_B_PORTFOLIO_QUALITY_FLOOR', 0.35, 61),
    ],
    notes: 'Reuses V8ShadowMetaInput (declared in v8-shadow-meta-scorer.ts); the ?? 0 momentum default lives HERE (l.135-137), not in S3 — the corrected attribution vs component map section 1.',
  },
  {
    key: 'scorer.s3-v8-shadow-meta',
    path: `${AI}/v8-shadow-meta-scorer.ts`,
    artifact: 'V8_SHADOW_ARTIFACT',
    dialect: 'standardized features ((x-center)/scale) + one-hot side/sym/ps + hour harmonics; fitted logistic',
    missingValueRule: 'THROW_ON_NON_FINITE',
    missingValueEvidence: 'finite() throws on any non-finite required input (l.89-92, applied l.100-105); shortHorizonMomentumAtr is declared in V8ShadowMetaInput (l.27) but NEVER read by the scoring function',
    columns: [
      'confidence (input, standardized (x-0.7)/0.08)', 'extensionAtr (standardized (x-0.75)/0.75)',
      'volatilityScore (standardized (x-0.375)/0.375)', 'emaSeparation (standardized (x-0.5)/0.5)',
      'mtfStrength (standardized (x-0.5)/0.5)', 'rsi14 (rsiStrength (x-11)/11)',
      'scanTime (hour_sin/hour_cos)', 'direction (one-hot)', 'instrument (one-hot sym_/ps_)',
    ],
    weightGroups: [
      {
        name: 'BASE_WEIGHTS',
        formula: 'probability = sigmoid(logit); expectedR = p*(2.5/1.5) - (1-p)',
        sum: null,
        entryCount: 29,
        weights: [
          w('bias', -0.11578161968250648, 52), w('confidence', 0.17961055475997342, 53),
          w('ema', 0.2708431513544996, 54), w('extension', 0.1151803622647996, 55),
          w('hour_cos', -0.15313534925717265, 56), w('hour_sin', 0.215165154794897, 57),
          w('mtf', -0.3645333135056978, 58), w('rsi_strength', -0.047043617511801646, 59),
          w('side_BUY', -0.0492200649488142, 60), w('side_SELL', -0.04408451035852483, 61),
          w('sym_AUDUSD', -0.06265012373206902, 62), w('sym_EURUSD', 0.039099242595638996, 63),
          w('sym_GBPUSD', -0.1548319088627653, 64), w('sym_USDCAD', 0.32702887788665214, 65),
          w('sym_USDCHF', -0.15448575884341276, 66), w('sym_USDJPY', -0.10620810348194867, 67),
          w('ps_AUDUSD_BUY', 0.01305869144342724, 68), w('ps_AUDUSD_SELL', -0.07631086969446096, 69),
          w('ps_EURUSD_BUY', 0.09263580825761873, 70), w('ps_EURUSD_SELL', -0.05360183633069556, 71),
          w('ps_GBPUSD_BUY', -0.10808016199943021, 72), w('ps_GBPUSD_SELL', -0.047992133392960365, 73),
          w('ps_USDCAD_BUY', 0.008070580817087548, 74), w('ps_USDCAD_SELL', 0.31933167577784016, 75),
          w('ps_USDCHF_BUY', -0.09518244851847857, 76), w('ps_USDCHF_SELL', -0.060323651816662834, 77),
          w('ps_USDJPY_BUY', 0.03126335181044257, 78), w('ps_USDJPY_SELL', -0.1376652746435702, 79),
          w('volatility', 0.029796295461264378, 80),
        ],
      },
    ],
    thresholds: [
      w('V8_SHADOW_ADMISSION_THRESHOLD', 0.46, 3),
      w('PLAN_B_SHADOW_ADMISSION_THRESHOLD', 0.40828402366863903, 7),
    ],
    notes: 'Fitted logistic: weights are NOT normalized (sum unconstrained); 29 entries pinned. Plan-B variant subtracts frozen sym+ps logit contributions (l.146-156); clock-neutral research variant subtracts the hour harmonics (l.178-199).',
  },
  {
    key: 'scorer.s4-adaptive-opportunity',
    path: `${AI}/adaptive-opportunity-score.ts`,
    artifact: 'ADAPTIVE_OPPORTUNITY_SCORE_ARTIFACT',
    dialect: 'opportunity aggregation; direction enters only as an upstream directionQuality INPUT at weight 0.11 of 1.00',
    missingValueRule: 'ZERO_OR_NEUTRAL_ON_MISSING',
    missingValueEvidence: 'clamp01 returns 0 on non-finite (l.73-75); shadowDirectionalPulseQuality undefined -> 0.5 (l.111-114); profitFactor/maxDrawdown null -> 0.4 (l.103-104)',
    columns: [
      'netExpectedR', 'estimatedExecutionCostR', 'directionQuality (input)', 'tradeQuality',
      'exitQuality', 'driftQuality', 'shadowDirectionalPulseQuality?', 'hardBlockers',
      'marketState{state,stateConfidence,canUpsize}', 'edge{...}', 'exposure{...}',
    ],
    weightGroups: [
      {
        name: 'ADAPTIVE_OPPORTUNITY_WEIGHTS',
        formula: 'clamp01(sum of 10 weighted components)',
        sum: 1,
        weights: [
          w('netExpectedR', 0.24, 8), w('regimeFit', 0.14, 9),
          w('directionQuality', 0.11, 10), w('tradeQuality', 0.1, 11),
          w('exitQuality', 0.08, 12), w('edgeQuality', 0.08, 13),
          w('shadowDirectionalPulseQuality', 0.05, 14), w('executionCostQuality', 0.08, 15),
          w('diversificationQuality', 0.07, 16), w('stabilityQuality', 0.05, 17),
        ],
      },
    ],
    thresholds: [],
    notes: 'Not a direction scorer itself: it aggregates. Under DS-1 its directionQuality slot consumes the calibrated probability; the silent zero-on-NaN clamp is replaced by SCORER_INPUT_REQUIRED.',
  },
];

const DIRECTION_SCORER_CONTRACT_COMPONENT_COUNT = SCORERS.length; // 4 — reconciles with component map / audit A1

// -------------------------------------------------------------- the contract

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

const DIRECTION_SCORER_CONTRACT = deepFreeze(Object.freeze({
  meta: Object.freeze({
    artifact: CONTRACT_ARTIFACT,
    capturedOn: '2026-11-27',
    scope: 'P1-1 direction-scorer unification (research-only)',
    executionAuthority: 'NONE',
    specDoc: 'docs/research/AI_ENGINE_V2_P1_1_DIRECTION_SCORER_UNIFICATION_SPEC_20261127.md',
    componentMapRef: 'v2-engine-component-map-v1',
    auditReference: 'docs/research/AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md (finding A1)',
  }),
  scorers: SCORERS,
  missingValueDivergenceCount: 4,
  unifiedContract: Object.freeze({
    name: 'DS-1',
    alignmentConvention: 'direction alignment applied exactly once, at ingestion; signed columns are positive when favoring the candidate direction',
    prohibitedInputs: Object.freeze(['confidence']),
    columns: DS1_COLUMNS,
    outputFields: DS1_OUTPUT_FIELDS,
    refusals: DS1_REFUSALS,
    missingValueRule: Object.freeze({
      required: 'absent/null/undefined/non-finite -> typed refusal SCORER_INPUT_REQUIRED (fail-closed; no silent default, no NaN propagation, no crash)',
      optional: 'nullable: absence recorded as null with an explicit presence flag; never rewritten to 0',
      ratioNeutral: 'm5BodyExpansionRatio absent -> recorded null; neutral 1.0 only in V1-compat replay with the substitution logged',
      range: 'out-of-declared-range -> typed refusal SCORER_INPUT_OUT_OF_RANGE (never clamped into range)',
    }),
  }),
}));

// -------------------------------------------------------------- validation

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate the structural integrity of a direction-scorer contract.
 * Typed refusals: CONTRACT_INPUT_REQUIRED, CONTRACT_META_INCOMPLETE,
 * CONTRACT_COUNT_MISMATCH, CONTRACT_DUPLICATE_KEY, CONTRACT_MISSING_FIELD,
 * CONTRACT_COLUMN_MALFORMED, CONTRACT_WEIGHT_MALFORMED,
 * CONTRACT_WEIGHT_SUM_MISMATCH, CONTRACT_UNKNOWN_UNIT, CONTRACT_UNKNOWN_GROUP.
 */
function validateDirectionScorerContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('CONTRACT_INPUT_REQUIRED');
  }
  const meta = contract.meta;
  if (!meta || !nonEmptyString(meta.artifact) || !nonEmptyString(meta.capturedOn)
    || !nonEmptyString(meta.scope) || !nonEmptyString(meta.specDoc)) {
    throw new Error('CONTRACT_META_INCOMPLETE');
  }
  if (meta.executionAuthority !== 'NONE') {
    throw new Error('CONTRACT_META_INCOMPLETE: executionAuthority must be NONE');
  }
  if (!Array.isArray(contract.scorers) || contract.scorers.length !== 4) {
    throw new Error('CONTRACT_COUNT_MISMATCH: exactly four direction scorers required');
  }
  const seenKeys = new Set();
  const rules = new Set();
  const units = new Set(DS1_UNITS);
  const groups = new Set(DS1_GROUPS);
  for (const [index, scorer] of contract.scorers.entries()) {
    if (!scorer || typeof scorer !== 'object') {
      throw new Error(`CONTRACT_MISSING_FIELD: scorers[${index}] malformed`);
    }
    if (!nonEmptyString(scorer.key)) {
      throw new Error(`CONTRACT_MISSING_FIELD: scorers[${index}].key`);
    }
    if (seenKeys.has(scorer.key)) {
      throw new Error(`CONTRACT_DUPLICATE_KEY: ${scorer.key}`);
    }
    seenKeys.add(scorer.key);
    if (!nonEmptyString(scorer.path) || scorer.path.startsWith('/') || scorer.path.includes('..')) {
      throw new Error(`CONTRACT_MISSING_FIELD: scorers[${index}].path must be a relative in-repo path`);
    }
    if (!nonEmptyString(scorer.artifact) || !nonEmptyString(scorer.dialect)
      || !nonEmptyString(scorer.missingValueRule) || !nonEmptyString(scorer.missingValueEvidence)
      || !nonEmptyString(scorer.notes)) {
      throw new Error(`CONTRACT_MISSING_FIELD: scorers[${index}] inventory fields`);
    }
    if (!MISSING_VALUE_RULES.includes(scorer.missingValueRule)) {
      throw new Error(`CONTRACT_MISSING_FIELD: scorers[${index}] unknown missing-value rule ${scorer.missingValueRule}`);
    }
    rules.add(scorer.missingValueRule);
    if (!Array.isArray(scorer.columns) || !scorer.columns.length
      || scorer.columns.some((c) => !nonEmptyString(c))) {
      throw new Error(`CONTRACT_COLUMN_MALFORMED: scorers[${index}].columns`);
    }
    if (!Array.isArray(scorer.weightGroups) || !scorer.weightGroups.length) {
      throw new Error(`CONTRACT_WEIGHT_MALFORMED: scorers[${index}].weightGroups`);
    }
    scorer.weightGroups.forEach((group, gIndex) => {
      if (!nonEmptyString(group.name) || !nonEmptyString(group.formula)
        || !Array.isArray(group.weights) || !group.weights.length) {
        throw new Error(`CONTRACT_WEIGHT_MALFORMED: scorers[${index}].weightGroups[${gIndex}]`);
      }
      group.weights.forEach((entry, wIndex) => {
        if (!nonEmptyString(entry.name) || !finiteNumber(entry.value)
          || !Number.isInteger(entry.line) || entry.line < 1) {
          throw new Error(`CONTRACT_WEIGHT_MALFORMED: scorers[${index}].weightGroups[${gIndex}].weights[${wIndex}]`);
        }
      });
      if (group.sum === 1) {
        const total = group.weights.reduce((acc, entry) => acc + entry.value, 0);
        if (Math.abs(total - 1) > 1e-9) {
          throw new Error(`CONTRACT_WEIGHT_SUM_MISMATCH: ${scorer.key}.${group.name} sums to ${total}`);
        }
      }
      if (group.entryCount !== undefined) {
        if (group.weights.length !== group.entryCount) {
          throw new Error(`CONTRACT_COUNT_MISMATCH: ${scorer.key}.${group.name} entryCount ${group.entryCount} != ${group.weights.length}`);
        }
      }
    });
    (scorer.thresholds || []).forEach((t) => {
      if (!nonEmptyString(t.name) || !finiteNumber(t.value) || !Number.isInteger(t.line) || t.line < 1) {
        throw new Error(`CONTRACT_WEIGHT_MALFORMED: ${scorer.key}.thresholds`);
      }
    });
  }
  if (contract.missingValueDivergenceCount !== rules.size) {
    throw new Error(`CONTRACT_COUNT_MISMATCH: missingValueDivergenceCount ${contract.missingValueDivergenceCount} != ${rules.size} distinct rules`);
  }
  if (contract.missingValueDivergenceCount !== 4) {
    throw new Error('CONTRACT_COUNT_MISMATCH: exactly four distinct missing-value rules are the P1-1 evidence');
  }

  const unified = contract.unifiedContract;
  if (!unified || !nonEmptyString(unified.name)) {
    throw new Error('CONTRACT_MISSING_FIELD: unifiedContract');
  }
  if (!Array.isArray(unified.prohibitedInputs) || !unified.prohibitedInputs.includes('confidence')) {
    throw new Error('CONTRACT_MISSING_FIELD: unifiedContract.prohibitedInputs must prohibit confidence');
  }
  if (!Array.isArray(unified.columns) || unified.columns.length < 20) {
    throw new Error('CONTRACT_COLUMN_MALFORMED: unifiedContract.columns');
  }
  const seenColumns = new Set();
  for (const [index, column] of unified.columns.entries()) {
    if (!nonEmptyString(column.name) || typeof column.required !== 'boolean') {
      throw new Error(`CONTRACT_COLUMN_MALFORMED: unifiedContract.columns[${index}]`);
    }
    if (seenColumns.has(column.name)) {
      throw new Error(`CONTRACT_DUPLICATE_KEY: column ${column.name}`);
    }
    seenColumns.add(column.name);
    if (!units.has(column.unit)) {
      throw new Error(`CONTRACT_UNKNOWN_UNIT: ${column.unit} (column ${column.name})`);
    }
    if (!groups.has(column.group)) {
      throw new Error(`CONTRACT_UNKNOWN_GROUP: ${column.group} (column ${column.name})`);
    }
  }
  if (!Array.isArray(unified.outputFields) || unified.outputFields.length < 6) {
    throw new Error('CONTRACT_MISSING_FIELD: unifiedContract.outputFields');
  }
  for (const field of unified.outputFields) {
    if (!nonEmptyString(field.name) || !nonEmptyString(field.semantics)) {
      throw new Error('CONTRACT_MISSING_FIELD: unifiedContract.outputFields entries');
    }
  }
  const outputNames = unified.outputFields.map((f) => f.name);
  for (const requiredOutput of ['rawScore', 'probability', 'calibrationState', 'inputsUsed', 'executionAuthority']) {
    if (!outputNames.includes(requiredOutput)) {
      throw new Error(`CONTRACT_MISSING_FIELD: unifiedContract.outputFields must include ${requiredOutput}`);
    }
  }
  if (!Array.isArray(unified.refusals) || !unified.refusals.includes('SCORER_INPUT_REQUIRED')
    || !unified.refusals.includes('SCORER_UNSUPPORTED_INSTRUMENT')
    || !unified.refusals.includes('SCORER_INPUT_OUT_OF_RANGE')) {
    throw new Error('CONTRACT_MISSING_FIELD: unifiedContract.refusals');
  }
  return true;
}

/**
 * Verify every mapped scorer source path exists under the repository root.
 * Typed refusal: CONTRACT_SCORER_PATH_NOT_FOUND. Returns { verified, total }.
 */
function verifyScorerPaths(contract, repoRoot) {
  if (!contract || !Array.isArray(contract.scorers)) {
    throw new Error('CONTRACT_INPUT_REQUIRED');
  }
  if (!nonEmptyString(repoRoot)) {
    throw new Error('CONTRACT_INPUT_REQUIRED: repoRoot');
  }
  let verified = 0;
  for (const scorer of contract.scorers) {
    const resolved = path.join(repoRoot, scorer.path);
    if (!fs.existsSync(resolved)) {
      throw new Error(`CONTRACT_SCORER_PATH_NOT_FOUND: ${scorer.path} (scorer ${scorer.key})`);
    }
    verified += 1;
  }
  return { verified, total: contract.scorers.length };
}

/** Summary: scorer keys, dialects, divergence rules, DS-1 column counts. */
function summarizeDirectionScorerContract(contract) {
  validateDirectionScorerContract(contract);
  const required = contract.unifiedContract.columns.filter((c) => c.required).length;
  const optional = contract.unifiedContract.columns.length - required;
  return {
    artifact: contract.meta.artifact,
    scorers: contract.scorers.map((s) => ({ key: s.key, missingValueRule: s.missingValueRule })),
    missingValueDivergenceCount: contract.missingValueDivergenceCount,
    ds1: {
      name: contract.unifiedContract.name,
      columns: contract.unifiedContract.columns.length,
      required,
      optional,
      prohibitedInputs: contract.unifiedContract.prohibitedInputs,
    },
  };
}

// ------------------------------------------- DS-1 application surface (fail-closed)

const OPTIONAL_COLUMNS = DS1_COLUMNS.filter((c) => !c.required).map((c) => c.name);
// Identity columns are validated by their own enum/date/string rules before
// the numeric loop; only numeric feature columns go through it.
const IDENTITY_COLUMNS = DS1_COLUMNS.filter((c) => c.group === 'identity').map((c) => c.name);
const REQUIRED_COLUMNS = DS1_COLUMNS
  .filter((c) => c.required && c.group !== 'identity')
  .map((c) => c.name);

const BOUNDED_COLUMNS = Object.freeze({
  rsi14: [0, 100],
  volatilityScore: [0, 1],
  closeLocation: [0, 1],
  lowerWickRatio: [0, 1],
  upperWickRatio: [0, 1],
  efficiency5: [0, 1],
  m5BodyExpansionRatio: [0, Infinity],
  higherTimeframeAgreement: [-1, 1],
  'alignment.m5': [-1, 1],
  'alignment.m15': [-1, 1],
  'alignment.h1': [-1, 1],
  'alignment.h4': [-1, 1],
  m5LatestBodyPressure: [-1, 1],
  m30DirectionalEfficiency: [-1, 1],
  m5BodyPressure3: [-1, 1],
});

/**
 * Apply the DS-1 contract to a raw input record. Research-only demonstration
 * of the unified semantics: required columns must be present and finite
 * (SCORER_INPUT_REQUIRED), the instrument must be one of the six majors
 * (SCORER_UNSUPPORTED_INSTRUMENT), bounded columns must be within range
 * (SCORER_INPUT_OUT_OF_RANGE), and absent optional columns are recorded as
 * null with an explicit presence flag — never silently defaulted.
 */
function applyDirectionScorerContract(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('SCORER_INPUT_REQUIRED: input record');
  }
  const instrument = typeof input.instrument === 'string' ? input.instrument.trim().toUpperCase() : input.instrument;
  if (!SUPPORTED_INSTRUMENTS.includes(instrument)) {
    throw new Error(`SCORER_UNSUPPORTED_INSTRUMENT: ${input.instrument}`);
  }
  if (input.direction !== 'BUY' && input.direction !== 'SELL') {
    throw new Error('SCORER_INPUT_OUT_OF_RANGE: direction must be BUY or SELL');
  }
  if (!(input.decisionTime instanceof Date) || !Number.isFinite(input.decisionTime.getTime())) {
    throw new Error('SCORER_INPUT_REQUIRED: decisionTime');
  }
  if (!nonEmptyString(input.policyVersion)) {
    throw new Error('SCORER_INPUT_REQUIRED: policyVersion');
  }
  const normalized = {};
  const inputsUsed = [];
  for (const name of REQUIRED_COLUMNS) {
    const value = input[name];
    if (value === undefined || value === null || !finiteNumber(value)) {
      throw new Error(`SCORER_INPUT_REQUIRED: ${name}`);
    }
    const bounds = BOUNDED_COLUMNS[name];
    if (bounds && (value < bounds[0] || value > bounds[1])) {
      throw new Error(`SCORER_INPUT_OUT_OF_RANGE: ${name}=${value} outside [${bounds[0]}, ${bounds[1]}]`);
    }
    normalized[name] = value;
    inputsUsed.push(name);
  }
  const presence = {};
  for (const name of OPTIONAL_COLUMNS) {
    const value = input[name];
    if (value === undefined || value === null) {
      normalized[name] = null;
      presence[name] = false;
      continue;
    }
    if (!finiteNumber(value)) {
      throw new Error(`SCORER_INPUT_REQUIRED: ${name} present but non-finite`);
    }
    const bounds = BOUNDED_COLUMNS[name];
    if (bounds && (value < bounds[0] || value > bounds[1])) {
      throw new Error(`SCORER_INPUT_OUT_OF_RANGE: ${name}=${value} outside [${bounds[0]}, ${bounds[1]}]`);
    }
    if (name === 'm5DirectionalRun' && !Number.isInteger(value)) {
      throw new Error(`SCORER_INPUT_OUT_OF_RANGE: m5DirectionalRun must be an integer count`);
    }
    normalized[name] = value;
    presence[name] = true;
    inputsUsed.push(name);
  }
  return {
    accepted: true,
    instrument,
    direction: input.direction,
    decisionTime: input.decisionTime.toISOString(),
    policyVersion: input.policyVersion,
    normalized,
    optionalPresence: presence,
    inputsUsed,
    executionAuthority: 'NONE',
  };
}

module.exports = {
  DIRECTION_SCORER_CONTRACT,
  SUPPORTED_INSTRUMENTS,
  MISSING_VALUE_RULES,
  DS1_COLUMNS,
  DS1_OUTPUT_FIELDS,
  DS1_REFUSALS,
  validateDirectionScorerContract,
  verifyScorerPaths,
  summarizeDirectionScorerContract,
  applyDirectionScorerContract,
};
