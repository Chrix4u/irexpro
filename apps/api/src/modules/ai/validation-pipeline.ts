export type ValidationGateState = 'PASS' | 'BLOCKED' | 'WAITING';
export type ValidationGateCode =
  | 'MARKET_DATA'
  | 'REGIME'
  | 'MODEL_QUALITY'
  | 'CONSENSUS'
  | 'NET_EDGE'
  | 'DRIFT'
  | 'EVENT_RISK'
  | 'PAPER_EXECUTION';

export interface ValidationGateView {
  code: ValidationGateCode;
  label: string;
  state: ValidationGateState;
  detail: string;
}

export interface ValidationPipelineCandidate {
  instrument: string;
  direction: 'BUY' | 'SELL';
  evaluatedAt: string;
  marketBarTime: string;
  regime: string;
  strategyRoute: string | null;
  confidence: number;
  ensembleScore: number;
  metaProbability: number;
  expectedR: number;
  netExpectedR: number | null;
  status: 'READY' | 'BLOCKED' | 'WAITING';
  passedGates: number;
  totalGates: number;
  primaryBlocker: string | null;
  blockers: string[];
  gates: ValidationGateView[];
}

export interface ValidationPipelineThresholds {
  candidateConfidenceFloor: number;
  metaProbabilityFloor: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function object(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function gate(
  code: ValidationGateCode,
  label: string,
  state: ValidationGateState,
  detail: string,
): ValidationGateView {
  return { code, label, state, detail };
}

function passBlockWaiting(
  evidence: boolean | null,
  passDetail: string,
  blockedDetail: string,
  waitingDetail: string,
): [ValidationGateState, string] {
  if (evidence === true) return ['PASS', passDetail];
  if (evidence === false) return ['BLOCKED', blockedDetail];
  return ['WAITING', waitingDetail];
}

export function buildValidationPipelineCandidate(
  row: Record<string, unknown>,
  thresholds: ValidationPipelineThresholds,
): ValidationPipelineCandidate {
  const components = object(row.components);
  const governance = object(components.governance);
  const reasons = strings(row.reasons);
  const governanceBlockers = strings(governance.blockers);
  const paperExecutionBlockers = strings(governance.paperExecutionBlockers);
  const blockers = [...new Set([...reasons, ...governanceBlockers, ...paperExecutionBlockers])];

  const instrument = String(row.instrument ?? '')
    .trim()
    .toUpperCase();
  const direction = row.direction === 'SELL' ? 'SELL' : 'BUY';
  const regime = String(row.regime ?? 'UNKNOWN');
  const confidence = finite(row.confidence) ?? 0;
  const ensembleScore = finite(row.ensemble_score) ?? 0;
  const metaProbability = finite(row.meta_probability) ?? 0;
  const expectedR = finite(row.expected_r) ?? 0;
  const netExpectedR = finite(governance.netExpectedR);
  const consensusPassed = finite(row.consensus_passed);
  const consensusRequired = finite(row.consensus_required);
  const directionQuality = finite(components.directionQuality);
  const tradeQuality = finite(components.tradeQuality);
  const exitQuality = finite(components.exitQuality);

  const modelEvidenceAvailable =
    directionQuality !== null && tradeQuality !== null && exitQuality !== null;
  const modelPassed =
    modelEvidenceAvailable &&
    confidence >= thresholds.candidateConfidenceFloor &&
    metaProbability >= thresholds.metaProbabilityFloor &&
    !reasons.some((reason) =>
      [
        'CONFIDENCE_FLOOR',
        'META_EXPECTED_VALUE',
        'EXPECTED_R',
        'DIRECTION_QUALITY',
        'TRADE_QUALITY',
        'EXIT_FEASIBILITY',
      ].includes(reason),
    );

  const regimeAllowed = bool(row.regime_allowed);
  const consensusEvidence =
    consensusPassed === null || consensusRequired === null
      ? null
      : consensusPassed >= consensusRequired;
  const paperNetExpectedRPassed = bool(governance.paperNetExpectedRPassed);
  const paperDriftPassed = bool(governance.paperDriftPassed) ?? bool(governance.driftPassed);
  const eventRisk = typeof governance.eventRisk === 'string' ? governance.eventRisk : null;
  const paperExecutionEligible = bool(governance.paperExecutionEligible);

  const [regimeState, regimeDetail] = passBlockWaiting(
    regimeAllowed,
    `Regime ${regime} is eligible`,
    `Regime ${regime} is not eligible for this route`,
    'Regime evidence is not available yet',
  );
  const [consensusState, consensusDetail] = passBlockWaiting(
    consensusEvidence,
    `${consensusPassed ?? 0}/${consensusRequired ?? 0} model checks agree`,
    `${consensusPassed ?? 0}/${consensusRequired ?? 0} model checks agree`,
    'Consensus evidence is not available yet',
  );
  const [netEdgeState, netEdgeDetail] = passBlockWaiting(
    paperNetExpectedRPassed,
    `Net edge ${netExpectedR?.toFixed(3) ?? '—'}R clears the PAPER floor`,
    `Net edge ${netExpectedR?.toFixed(3) ?? '—'}R is below the PAPER floor`,
    'Net execution edge is still being evaluated',
  );
  const [driftState, driftDetail] = passBlockWaiting(
    paperDriftPassed,
    `Drift is ${String(governance.driftState ?? 'NORMAL')}`,
    `Drift is ${String(governance.driftState ?? 'BLOCKED')}`,
    'Drift evidence is not available yet',
  );
  const eventEvidence = eventRisk === null ? null : eventRisk === 'CLEAR';
  const [eventState, eventDetail] = passBlockWaiting(
    eventEvidence,
    'Macro-event risk is clear',
    `Macro-event guard is ${eventRisk ?? 'blocked'}`,
    'Macro-event risk is being verified',
  );
  const [executionState, executionDetail] = passBlockWaiting(
    paperExecutionEligible,
    'Backend has declared this setup PAPER-execution eligible',
    paperExecutionBlockers.length > 0
      ? `Execution blocked: ${paperExecutionBlockers.join(', ')}`
      : 'Final PAPER execution gate is blocked',
    'Final PAPER execution decision is not available yet',
  );

  const modelState: ValidationGateState = !modelEvidenceAvailable
    ? 'WAITING'
    : modelPassed
      ? 'PASS'
      : 'BLOCKED';
  const modelDetail = !modelEvidenceAvailable
    ? 'Model-quality evidence is still being assembled'
    : modelPassed
      ? `Confidence ${(confidence * 100).toFixed(1)}% · meta ${(metaProbability * 100).toFixed(1)}% · quality checks passed`
      : `Model quality blocked${reasons.length ? `: ${reasons.join(', ')}` : ''}`;

  const gates: ValidationGateView[] = [
    gate(
      'MARKET_DATA',
      'Market data',
      'PASS',
      'Fresh decision evidence was persisted for this pair',
    ),
    gate('REGIME', 'Regime', regimeState, regimeDetail),
    gate('MODEL_QUALITY', 'Model quality', modelState, modelDetail),
    gate('CONSENSUS', 'Consensus', consensusState, consensusDetail),
    gate('NET_EDGE', 'Net edge', netEdgeState, netEdgeDetail),
    gate('DRIFT', 'Drift', driftState, driftDetail),
    gate('EVENT_RISK', 'Event risk', eventState, eventDetail),
    gate('PAPER_EXECUTION', 'Execution', executionState, executionDetail),
  ];

  const passedGates = gates.filter((item) => item.state === 'PASS').length;
  const firstBlocked = gates.find((item) => item.state === 'BLOCKED');
  const firstWaiting = gates.find((item) => item.state === 'WAITING');
  const status: ValidationPipelineCandidate['status'] =
    paperExecutionEligible === true ? 'READY' : firstBlocked ? 'BLOCKED' : 'WAITING';

  return {
    instrument,
    direction,
    evaluatedAt: iso(row.evaluated_at),
    marketBarTime: iso(row.market_bar_time),
    regime,
    strategyRoute: typeof components.strategyRoute === 'string' ? components.strategyRoute : null,
    confidence,
    ensembleScore,
    metaProbability,
    expectedR,
    netExpectedR,
    status,
    passedGates,
    totalGates: gates.length,
    primaryBlocker: firstBlocked?.detail ?? firstWaiting?.detail ?? null,
    blockers,
    gates,
  };
}
