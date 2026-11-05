/**
 * z.ai P1: broker reconciliation proof for a FUTURE cTrader DEMO partial exit.
 * Deterministic, read-only, no dispatch authority. Financial values remain
 * opaque provider strings until commission/swap sign and currency are checked.
 */
export type PartialCloseProofReason =
  | 'NOT_CTRADER_DEMO'
  | 'MISSING_PROVIDER_DEAL'
  | 'UNVERIFIED_VOLUME'
  | 'PARTIAL_VOLUME_MISMATCH'
  | 'VOLUME_CONSERVATION_FAILED'
  | 'INCOMPLETE_BROKER_ECONOMICS'
  | 'CONFIRMED';

export interface PartialCloseProofInput {
  brokerId: string;
  accountType: string;
  accountCurrency: string | null;
  providerDealId: string | null;
  originalLots: string;
  requestedCloseLots: string;
  brokerLotsBefore: string | null;
  brokerFilledLots: string | null;
  brokerLotsAfter: string | null;
  grossRealisedPnl: string | null;
  commission: string | null;
  swap: string | null;
}

export interface PartialCloseProof {
  reason: PartialCloseProofReason;
  providerConfirmed: boolean;
  economicsComplete: boolean;
  /** This function is not, and must not become, an execution authorization. */
  canDispatchOrder: false;
  remainingLots: string | null;
}

function parseLots(value: string | null): bigint | null {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const lots = BigInt(whole) * 10000n + BigInt(frac.padEnd(4, '0'));
  return lots > 0n ? lots : null;
}

function parseNonnegativeLots(value: string | null): bigint | null {
  if (value === '0' || value === '0.0000') return 0n;
  return parseLots(value);
}

function validEconomic(value: string | null): boolean {
  return value !== null && /^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value);
}

export function evaluatePartialCloseProof(input: PartialCloseProofInput): PartialCloseProof {
  const result = (
    reason: PartialCloseProofReason,
    remainingLots: string | null = null,
    economicsComplete = false,
  ): PartialCloseProof => ({
    reason,
    providerConfirmed: reason === 'CONFIRMED',
    economicsComplete,
    canDispatchOrder: false,
    remainingLots,
  });

  if (input.brokerId.toLowerCase() !== 'ctrader' || input.accountType.toUpperCase() !== 'DEMO') {
    return result('NOT_CTRADER_DEMO');
  }
  if (!input.providerDealId?.trim()) return result('MISSING_PROVIDER_DEAL');
  if (!input.accountCurrency || !/^[A-Z]{3}$/.test(input.accountCurrency)) {
    return result('INCOMPLETE_BROKER_ECONOMICS');
  }

  const original = parseLots(input.originalLots);
  const requested = parseLots(input.requestedCloseLots);
  const before = parseLots(input.brokerLotsBefore);
  const filled = parseLots(input.brokerFilledLots);
  const after = parseNonnegativeLots(input.brokerLotsAfter);

  if (
    original === null ||
    requested === null ||
    requested >= original ||
    requested * 2n !== original ||
    before === null ||
    filled === null ||
    after === null
  ) {
    return result('UNVERIFIED_VOLUME');
  }
  if (filled !== requested || before !== original) {
    return result('PARTIAL_VOLUME_MISMATCH');
  }
  if (after === 0n) return result('UNVERIFIED_VOLUME');
  if (before !== filled + after) {
    return result('VOLUME_CONSERVATION_FAILED');
  }
  const remaining = (Number(after) / 10000).toFixed(4);
  const economicsComplete =
    validEconomic(input.grossRealisedPnl) &&
    validEconomic(input.commission) &&
    validEconomic(input.swap);
  if (!economicsComplete) return result('INCOMPLETE_BROKER_ECONOMICS', remaining);
  return result('CONFIRMED', remaining, true);
}
