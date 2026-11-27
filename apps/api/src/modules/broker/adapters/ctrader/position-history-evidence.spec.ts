import { comparePositionHistoryEvidence } from './position-history-evidence';

const entry = {
  dealId: 11,
  orderId: 21,
  positionId: 31,
  symbolId: 41,
  executionTimestamp: 1700000000000,
  filledVolume: 100000,
  tradeSide: 1,
  dealStatus: 2,
};
const close = {
  ...entry,
  dealId: 12,
  orderId: 22,
  executionTimestamp: 1700000000001,
  tradeSide: 2,
  closePositionDetail: {},
};
const response = (deal: unknown[]) => ({ ctidTraderAccountId: 1, hasMore: false, deal });
const compare = (positionHistoryResponse: unknown, broadHistoryResponse: unknown) =>
  comparePositionHistoryEvidence({
    accountId: 1,
    positionId: 31,
    positionHistoryResponse,
    broadHistoryResponse,
  });

describe('offline position history evidence', () => {
  it('compares the same native identities independently of response order', () => {
    expect(compare(response([entry, close]), response([close, entry]))).toEqual({
      status: 'COMPARED',
      positionDealCount: 2,
      positionClosingDealCount: 1,
      absentFromBroadHistory: 0,
      extraInBroadHistory: 0,
      conflictingNativeDealFields: 0,
      singleClosingDealCandidate: true,
    });
  });

  it('reports missing and extra deal IDs rather than inventing a match', () => {
    expect(
      compare(response([entry, close]), response([entry, { ...close, dealId: 13 }])),
    ).toMatchObject({ absentFromBroadHistory: 1, extraInBroadHistory: 1 });
    expect(compare(response([]), response([]))).toMatchObject({
      positionClosingDealCount: 0,
      singleClosingDealCandidate: false,
    });
  });

  it('preserves multiple genuine closing deals at identical milliseconds', () => {
    const deals = [entry, close, { ...close, dealId: 13 }];
    expect(compare(response(deals), response(deals))).toMatchObject({
      positionClosingDealCount: 2,
      singleClosingDealCandidate: false,
    });
  });

  it('distinguishes a conflicting native field even when deal IDs match', () => {
    expect(
      compare(response([entry, close]), response([entry, { ...close, filledVolume: 200000 }])),
    ).toMatchObject({ conflictingNativeDealFields: 1 });
  });

  it('refuses truncation, account mismatch, wrong position and duplicate IDs', () => {
    for (const invalid of [
      { ...response([entry]), hasMore: true },
      { ...response([entry]), hasMore: undefined },
      { ...response([entry]), ctidTraderAccountId: 2 },
      response([entry, entry]),
      response([{ ...entry, positionId: 99 }]),
      response([{ ...entry, dealId: Number.MAX_SAFE_INTEGER + 1 }]),
      response([{ ...close, closePositionDetail: null }]),
    ]) {
      expect(compare(invalid, response([entry]))).toEqual({
        status: 'UNVERIFIED',
        reason: 'POSITION_HISTORY_INCOMPLETE_OR_INVALID',
      });
    }
    expect(compare(response([entry]), { ...response([entry]), hasMore: true })).toEqual({
      status: 'UNVERIFIED',
      reason: 'BROAD_HISTORY_INCOMPLETE_OR_INVALID',
    });
  });

  it('ignores unrelated positions only in broad account history', () => {
    expect(
      compare(response([entry]), response([entry, { ...close, positionId: 99 }])),
    ).toMatchObject({ positionDealCount: 1, extraInBroadHistory: 0 });
  });
});
