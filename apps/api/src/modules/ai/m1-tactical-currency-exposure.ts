import { decomposeCurrencyRisk, type ForexDirection } from './adaptive-currency-exposure';

export const M1_ALIGNED_CURRENCY_REDUCE_PERCENT = 2;
export const M1_ALIGNED_CURRENCY_BLOCK_PERCENT = 3;

export interface M1CurrencyRiskPosition {
  instrument: string;
  direction: ForexDirection;
  riskAtStop: number | null;
}

export interface M1CurrencyExposureDecision {
  capacity: 'CLEAR' | 'REDUCED' | 'BLOCKED';
  reason:
    | 'CURRENCY_CAPACITY_CLEAR'
    | 'CURRENCY_CAPACITY_REDUCED'
    | 'CURRENCY_CAPACITY_BLOCKED'
    | 'ALLOCATION_UNAVAILABLE'
    | 'RISK_EVIDENCE_INCOMPLETE';
  allocatedCapital: number;
  currentCurrencyRisk: Record<string, number>;
  projectedCurrencyRisk: Record<string, number>;
  projectedAlignedRisk: number;
  projectedAlignedRiskPercent: number;
}

export function m1UsdRiskAtStop(input: {
  instrument: string;
  lotSize: number;
  entryPrice: number;
  stopLoss: number;
}): number | null {
  const symbol = input.instrument.trim().toUpperCase();
  if (!/^[A-Z]{6}$/.test(symbol)) return null;
  if (![input.lotSize, input.entryPrice, input.stopLoss].every(Number.isFinite)) return null;
  if (input.lotSize <= 0 || input.entryPrice <= 0 || input.stopLoss <= 0) return null;
  const quoteRisk = Math.abs(input.entryPrice - input.stopLoss) * input.lotSize * 100_000;
  if (!Number.isFinite(quoteRisk) || quoteRisk <= 0) return null;
  const base = symbol.slice(0, 3);
  const quote = symbol.slice(3, 6);
  if (quote === 'USD') return quoteRisk;
  if (base === 'USD') return quoteRisk / input.entryPrice;
  return null;
}

function addRisk(target: Record<string, number>, delta: Record<string, number>): void {
  for (const [currency, value] of Object.entries(delta)) {
    target[currency] = (target[currency] ?? 0) + value;
  }
}

function blocked(
  reason: M1CurrencyExposureDecision['reason'],
  allocatedCapital: number,
): M1CurrencyExposureDecision {
  return {
    capacity: 'BLOCKED',
    reason,
    allocatedCapital,
    currentCurrencyRisk: {},
    projectedCurrencyRisk: {},
    projectedAlignedRisk: Number.POSITIVE_INFINITY,
    projectedAlignedRiskPercent: Number.POSITIVE_INFINITY,
  };
}


export function findLargestClearM1Volume(input: {
  allocatedCapital: number;
  positions: M1CurrencyRiskPosition[];
  candidate: {
    instrument: string;
    direction: ForexDirection;
    entryPrice: number;
    stopLoss: number;
  };
  requestedVolumeCap: number;
  productFloor: number;
  volumeStep: number;
}): {
  allowed: boolean;
  volumeCap: number;
  decision: M1CurrencyExposureDecision;
  productFloorBlocked: boolean;
} {
  const evaluateAtVolume = (volume: number) => {
    const riskAtStop = m1UsdRiskAtStop({
      instrument: input.candidate.instrument,
      lotSize: volume,
      entryPrice: input.candidate.entryPrice,
      stopLoss: input.candidate.stopLoss,
    });
    return evaluateM1TacticalCurrencyExposure({
      allocatedCapital: input.allocatedCapital,
      positions: input.positions,
      candidate: {
        instrument: input.candidate.instrument,
        direction: input.candidate.direction,
        riskAtStop: riskAtStop ?? 0,
      },
    });
  };

  const requestedDecision = evaluateAtVolume(input.requestedVolumeCap);
  if (!Number.isFinite(input.requestedVolumeCap) || input.requestedVolumeCap <= 0) {
    return {
      allowed: false,
      volumeCap: 0,
      decision: requestedDecision,
      productFloorBlocked: false,
    };
  }
  if (requestedDecision.capacity === 'CLEAR') {
    return {
      allowed: true,
      volumeCap: input.requestedVolumeCap,
      decision: requestedDecision,
      productFloorBlocked: false,
    };
  }

  if (!Number.isFinite(input.productFloor) || input.productFloor <= 0) {
    return {
      allowed: false,
      volumeCap: 0,
      decision: requestedDecision,
      productFloorBlocked: false,
    };
  }
  if (input.requestedVolumeCap <= input.productFloor) {
    return {
      allowed: false,
      volumeCap: 0,
      decision: requestedDecision,
      productFloorBlocked: true,
    };
  }

  const floorDecision = evaluateAtVolume(input.productFloor);
  if (floorDecision.capacity !== 'CLEAR') {
    return {
      allowed: false,
      volumeCap: 0,
      decision: floorDecision,
      productFloorBlocked: true,
    };
  }

  if (!Number.isFinite(input.volumeStep) || input.volumeStep <= 0) {
    return {
      allowed: false,
      volumeCap: 0,
      decision: floorDecision,
      productFloorBlocked: false,
    };
  }

  let bestVolume = input.productFloor;
  let bestDecision = floorDecision;
  const stepCount = Math.floor(
    (input.requestedVolumeCap - input.productFloor) / input.volumeStep + 1e-9,
  );
  for (let index = 1; index <= stepCount; index += 1) {
    const volume = Number((input.productFloor + index * input.volumeStep).toFixed(8));
    if (volume >= input.requestedVolumeCap - 1e-9) break;
    const decision = evaluateAtVolume(volume);
    if (decision.capacity === 'CLEAR') {
      bestVolume = volume;
      bestDecision = decision;
    }
  }

  return {
    allowed: true,
    volumeCap: bestVolume,
    decision: bestDecision,
    productFloorBlocked: false,
  };
}

/**
 * PAPER-only M1 portfolio governor. It preserves unlimited trade COUNT while
 * bounding the capital actually at risk in one aligned currency thesis.
 */
export function evaluateM1TacticalCurrencyExposure(input: {
  allocatedCapital: number;
  positions: M1CurrencyRiskPosition[];
  candidate: { instrument: string; direction: ForexDirection; riskAtStop: number };
}): M1CurrencyExposureDecision {
  if (!Number.isFinite(input.allocatedCapital) || input.allocatedCapital <= 0) {
    return blocked('ALLOCATION_UNAVAILABLE', input.allocatedCapital);
  }
  if (!Number.isFinite(input.candidate.riskAtStop) || input.candidate.riskAtStop <= 0) {
    return blocked('RISK_EVIDENCE_INCOMPLETE', input.allocatedCapital);
  }

  const currentCurrencyRisk: Record<string, number> = {};
  for (const position of input.positions) {
    if (
      position.riskAtStop === null ||
      !Number.isFinite(position.riskAtStop) ||
      position.riskAtStop <= 0
    ) {
      return blocked('RISK_EVIDENCE_INCOMPLETE', input.allocatedCapital);
    }
    const decomposed = decomposeCurrencyRisk(
      position.instrument,
      position.direction,
      position.riskAtStop,
    );
    if (Object.keys(decomposed).length !== 2) {
      return blocked('RISK_EVIDENCE_INCOMPLETE', input.allocatedCapital);
    }
    addRisk(currentCurrencyRisk, decomposed);
  }

  const candidateCurrencyRisk = decomposeCurrencyRisk(
    input.candidate.instrument,
    input.candidate.direction,
    input.candidate.riskAtStop,
  );
  if (Object.keys(candidateCurrencyRisk).length !== 2) {
    return blocked('RISK_EVIDENCE_INCOMPLETE', input.allocatedCapital);
  }
  const projectedCurrencyRisk = { ...currentCurrencyRisk };
  addRisk(projectedCurrencyRisk, candidateCurrencyRisk);

  const candidateCurrencies = Object.keys(candidateCurrencyRisk);
  const projectedAlignedRisk = Math.max(
    ...candidateCurrencies.map((currency) => Math.abs(projectedCurrencyRisk[currency] ?? 0)),
  );
  const projectedAlignedRiskPercent = (projectedAlignedRisk / input.allocatedCapital) * 100;
  const capacity =
    projectedAlignedRiskPercent >= M1_ALIGNED_CURRENCY_BLOCK_PERCENT
      ? 'BLOCKED'
      : projectedAlignedRiskPercent >= M1_ALIGNED_CURRENCY_REDUCE_PERCENT
        ? 'REDUCED'
        : 'CLEAR';
  return {
    capacity,
    reason:
      capacity === 'BLOCKED'
        ? 'CURRENCY_CAPACITY_BLOCKED'
        : capacity === 'REDUCED'
          ? 'CURRENCY_CAPACITY_REDUCED'
          : 'CURRENCY_CAPACITY_CLEAR',
    allocatedCapital: input.allocatedCapital,
    currentCurrencyRisk,
    projectedCurrencyRisk,
    projectedAlignedRisk,
    projectedAlignedRiskPercent,
  };
}
