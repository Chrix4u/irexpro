import { v5 as uuidv5 } from 'uuid';
import type { AiSignalCandidate } from './interfaces/ai-signal-candidate.interface';

export const INTERNAL_ADAPTIVE_STRATEGY_CODE = 'external-irexpro-multimodel-ensemble-v1';

const INTERNAL_ADAPTIVE_PROVIDER_CODE = 'irexpro-multimodel-ensemble-v1';
const ADAPTIVE_MATERIAL_SIGNAL_NAMESPACE = 'd2ee1d5a-9d99-4bd0-842f-53d97f7f384b';
const ADAPTIVE_MATERIAL_SIGNAL_SCHEME = 'adaptive-material-v1';

function producerSignalId(candidate: AiSignalCandidate): string {
  const priorProducerId = candidate.metadata?.producer_signal_id;
  return typeof priorProducerId === 'string' && priorProducerId.trim().length > 0
    ? priorProducerId
    : candidate.signalId;
}

function isInternalAdaptivePaperSignal(candidate: AiSignalCandidate): boolean {
  return (
    candidate.strategyCode === INTERNAL_ADAPTIVE_STRATEGY_CODE &&
    candidate.metadata?.external_provider_paper_only === true &&
    candidate.metadata?.external_provider_code === INTERNAL_ADAPTIVE_PROVIDER_CODE
  );
}

/**
 * Convert the collector's bar-level producer id into an execution identity
 * that is bound to the same material fields used by SignalIdentityGate.
 *
 * The producer id remains part of the key so two separate M5 opportunities
 * with identical trade geometry never collapse into one identity. generatedAt
 * is intentionally excluded: the collector owns retry timestamp reuse.
 */
export function materializeAdaptiveSignalIdentity(candidate: AiSignalCandidate): AiSignalCandidate {
  if (!isInternalAdaptivePaperSignal(candidate)) return candidate;

  const originalSignalId = producerSignalId(candidate);
  const materialKey = JSON.stringify({
    scheme: ADAPTIVE_MATERIAL_SIGNAL_SCHEME,
    producerSignalId: originalSignalId,
    instrument: candidate.instrument,
    direction: candidate.direction,
    requestedLotSize: String(candidate.suggestedVolume),
    entryPrice: candidate.suggestedEntryPrice ?? null,
    stopLoss: candidate.suggestedStopLoss,
    takeProfit: candidate.suggestedTakeProfit,
    strategyCode: candidate.strategyCode,
    timeframe: candidate.timeframe,
    modelVersion: candidate.modelVersion,
  });
  const materialSignalId = uuidv5(materialKey, ADAPTIVE_MATERIAL_SIGNAL_NAMESPACE);

  if (
    materialSignalId === candidate.signalId &&
    candidate.metadata?.producer_signal_id === originalSignalId &&
    candidate.metadata?.signal_identity_scheme === ADAPTIVE_MATERIAL_SIGNAL_SCHEME
  ) {
    return candidate;
  }

  return {
    ...candidate,
    signalId: materialSignalId,
    metadata: {
      ...candidate.metadata,
      producer_signal_id: originalSignalId,
      signal_identity_scheme: ADAPTIVE_MATERIAL_SIGNAL_SCHEME,
    },
  };
}
