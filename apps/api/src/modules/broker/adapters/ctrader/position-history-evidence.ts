/**
 * Offline evidence comparison for cTrader position history.
 * No authentication, provider requests, account discovery or settlement.
 * Inputs must originate from an independently authorized read of the same
 * account and an independently verified native position ID. This function
 * cannot authenticate those inputs or certify their provenance.
 */
type EvidenceResult =
  | { status: 'UNVERIFIED'; reason: string }
  | {
      status: 'COMPARED';
      positionDealCount: number;
      positionClosingDealCount: number;
      absentFromBroadHistory: number;
      extraInBroadHistory: number;
      conflictingNativeDealFields: number;
      singleClosingDealCandidate: boolean;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nativeId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

type DealEvidence = {
  signature: string;
  closesPosition: boolean;
};

function readPositionDeals(
  response: unknown,
  accountId: number,
  positionId: number,
  positionOnly: boolean,
): Map<number, DealEvidence> | null {
  const payload = record(response);
  if (
    !payload ||
    payload.ctidTraderAccountId !== accountId ||
    payload.hasMore !== false ||
    (payload.deal !== undefined && !Array.isArray(payload.deal))
  ) {
    return null;
  }
  const evidence = new Map<number, DealEvidence>();
  const seen = new Set<number>();
  for (const item of (payload.deal ?? []) as unknown[]) {
    const deal = record(item);
    if (!deal || !nativeId(deal.dealId) || !nativeId(deal.positionId) || seen.has(deal.dealId)) {
      return null;
    }
    seen.add(deal.dealId);
    if (deal.positionId !== positionId) {
      if (positionOnly) return null;
      continue;
    }
    if (
      !nativeId(deal.orderId) ||
      !nativeId(deal.symbolId) ||
      !nativeId(deal.executionTimestamp) ||
      !nativeId(deal.filledVolume) ||
      ![1, 2].includes(deal.tradeSide as number) ||
      ![2, 3].includes(deal.dealStatus as number)
    ) {
      return null;
    }
    const closesPosition = deal.closePositionDetail !== undefined;
    const detail = record(deal.closePositionDetail);
    if (closesPosition && !detail) return null;
    evidence.set(deal.dealId, {
      signature: JSON.stringify([
        deal.orderId,
        deal.positionId,
        deal.symbolId,
        deal.executionTimestamp,
        deal.filledVolume,
        deal.tradeSide,
        deal.dealStatus,
        closesPosition,
      ]),
      closesPosition,
    });
  }
  return evidence;
}

/** Aggregate-only native identity comparison; never a fill authorization. */
export function comparePositionHistoryEvidence(input: {
  accountId: number;
  positionId: number;
  positionHistoryResponse: unknown;
  broadHistoryResponse: unknown;
}): EvidenceResult {
  const { accountId, positionId } = input;
  if (!nativeId(accountId) || !nativeId(positionId)) {
    return { status: 'UNVERIFIED', reason: 'INVALID_NATIVE_IDENTITY' };
  }
  const position = readPositionDeals(input.positionHistoryResponse, accountId, positionId, true);
  if (!position) return { status: 'UNVERIFIED', reason: 'POSITION_HISTORY_INCOMPLETE_OR_INVALID' };
  const broad = readPositionDeals(input.broadHistoryResponse, accountId, positionId, false);
  if (!broad) return { status: 'UNVERIFIED', reason: 'BROAD_HISTORY_INCOMPLETE_OR_INVALID' };

  let absentFromBroadHistory = 0;
  let extraInBroadHistory = 0;
  let conflictingNativeDealFields = 0;
  let positionClosingDealCount = 0;
  for (const [id, deal] of position) {
    if (deal.closesPosition) positionClosingDealCount++;
    const other = broad.get(id);
    if (!other) absentFromBroadHistory++;
    else if (other.signature !== deal.signature) conflictingNativeDealFields++;
  }
  for (const id of broad.keys()) {
    if (!position.has(id)) extraInBroadHistory++;
  }
  return {
    status: 'COMPARED',
    positionDealCount: position.size,
    positionClosingDealCount,
    absentFromBroadHistory,
    extraInBroadHistory,
    conflictingNativeDealFields,
    // Cardinality only; no economic, dispatch-time, or settlement proof.
    singleClosingDealCandidate: positionClosingDealCount === 1,
  };
}
