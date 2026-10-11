import { api } from '@/lib/api';

export type BidirectionalDirection = 'BUY' | 'SELL';
export type BidirectionalStrategyRoute =
  | 'TREND_CONTINUATION'
  | 'CONFIRMED_REVERSAL'
  | 'EARLY_TRANSITION';
export type BidirectionalDriftState = 'NORMAL' | 'STRESSED' | 'OUT_OF_DISTRIBUTION';

export interface BidirectionalSideView {
  direction: BidirectionalDirection;
  evaluatedAt: string;
  confidence: number;
  metaProbability: number;
  grossExpectedR: number;
  netExpectedR: number | null;
  regime: string;
  strategyRoute: BidirectionalStrategyRoute | null;
  consensusPassed: number;
  consensusRequired: number;
  paperAdmitted: boolean;
  paperExecutionEligible: boolean;
  driftState: BidirectionalDriftState | null;
  blockers: string[];
}

export interface BidirectionalComparisonView {
  instrument: string;
  marketBarTime: string;
  decisionPolicyVersion: string;
  selectionStatus:
    | 'BUY_ELIGIBLE'
    | 'SELL_ELIGIBLE'
    | 'BOTH_ELIGIBLE'
    | 'NO_ELIGIBLE_DIRECTION';
  selectedDirection: BidirectionalDirection | null;
  buy: BidirectionalSideView | null;
  sell: BidirectionalSideView | null;
}

export interface BidirectionalDecisionView {
  generatedAt: string;
  policyVersion: string | null;
  comparisons: BidirectionalComparisonView[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function iso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function side(value: unknown): value is BidirectionalSideView {
  const item = record(value);
  if (!item) return false;
  const keys = [
    'direction',
    'evaluatedAt',
    'confidence',
    'metaProbability',
    'grossExpectedR',
    'netExpectedR',
    'regime',
    'strategyRoute',
    'consensusPassed',
    'consensusRequired',
    'paperAdmitted',
    'paperExecutionEligible',
    'driftState',
    'blockers',
  ];
  if (Object.keys(item).length !== keys.length || keys.some((key) => !(key in item))) return false;
  if (item.direction !== 'BUY' && item.direction !== 'SELL') return false;
  if (!iso(item.evaluatedAt)) return false;
  if (!finite(item.confidence) || item.confidence < 0 || item.confidence > 1) return false;
  if (!finite(item.metaProbability) || item.metaProbability < 0 || item.metaProbability > 1)
    return false;
  if (!finite(item.grossExpectedR)) return false;
  if (!(item.netExpectedR === null || finite(item.netExpectedR))) return false;
  if (typeof item.regime !== 'string' || item.regime.length === 0) return false;
  if (
    !(
      item.strategyRoute === null ||
      item.strategyRoute === 'TREND_CONTINUATION' ||
      item.strategyRoute === 'CONFIRMED_REVERSAL' ||
      item.strategyRoute === 'EARLY_TRANSITION'
    )
  )
    return false;
  if (!Number.isInteger(item.consensusPassed) || !Number.isInteger(item.consensusRequired)) return false;
  if (typeof item.paperAdmitted !== 'boolean' || typeof item.paperExecutionEligible !== 'boolean')
    return false;
  if (
    !(
      item.driftState === null ||
      item.driftState === 'NORMAL' ||
      item.driftState === 'STRESSED' ||
      item.driftState === 'OUT_OF_DISTRIBUTION'
    )
  )
    return false;
  return Array.isArray(item.blockers) && item.blockers.every((blocker) => typeof blocker === 'string');
}

function comparison(value: unknown): value is BidirectionalComparisonView {
  const item = record(value);
  if (!item) return false;
  const keys = [
    'instrument',
    'marketBarTime',
    'decisionPolicyVersion',
    'selectionStatus',
    'selectedDirection',
    'buy',
    'sell',
  ];
  if (Object.keys(item).length !== keys.length || keys.some((key) => !(key in item))) return false;
  if (typeof item.instrument !== 'string' || item.instrument.length < 3) return false;
  if (!iso(item.marketBarTime)) return false;
  if (typeof item.decisionPolicyVersion !== 'string' || item.decisionPolicyVersion.length === 0)
    return false;
  if (
    item.selectionStatus !== 'BUY_ELIGIBLE' &&
    item.selectionStatus !== 'SELL_ELIGIBLE' &&
    item.selectionStatus !== 'BOTH_ELIGIBLE' &&
    item.selectionStatus !== 'NO_ELIGIBLE_DIRECTION'
  )
    return false;
  if (!(item.selectedDirection === null || item.selectedDirection === 'BUY' || item.selectedDirection === 'SELL'))
    return false;
  return (item.buy === null || side(item.buy)) && (item.sell === null || side(item.sell));
}

function isView(value: unknown): value is BidirectionalDecisionView {
  const item = record(value);
  if (!item) return false;
  if (
    Object.keys(item).length !== 3 ||
    !('generatedAt' in item) ||
    !('policyVersion' in item) ||
    !('comparisons' in item)
  )
    return false;
  return (
    iso(item.generatedAt) &&
    (item.policyVersion === null || typeof item.policyVersion === 'string') &&
    Array.isArray(item.comparisons) &&
    item.comparisons.every(comparison)
  );
}

export async function loadBidirectionalDecisions(): Promise<BidirectionalDecisionView> {
  const payload = await api.request<unknown>('/ai/decision-comparisons');
  if (!isView(payload)) throw new Error('Bidirectional decision contract mismatch');
  return payload;
}
