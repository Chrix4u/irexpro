import { evaluatePartialCloseProof, PartialCloseProofInput } from './zai-p1-partial-leg-proof';

const input: PartialCloseProofInput = {
  brokerId: 'ctrader',
  accountType: 'DEMO',
  accountCurrency: 'EUR',
  providerDealId: 'verified-deal-1',
  originalLots: '0.0200',
  requestedCloseLots: '0.0100',
  brokerLotsBefore: '0.0200',
  brokerFilledLots: '0.0100',
  brokerLotsAfter: '0.0100',
  grossRealisedPnl: '0.85000000',
  commission: '-0.03000000',
  swap: '0.00000000',
};

describe('z.ai P1 DEMO partial-close broker proof (read-only)', () => {
  it('confirms a proven 0.02 -> 0.01/0.01 split with complete economics', () => {
    expect(evaluatePartialCloseProof(input)).toEqual({
      reason: 'CONFIRMED',
      providerConfirmed: true,
      economicsComplete: true,
      canDispatchOrder: false,
      remainingLots: '0.0100',
    });
  });

  it.each([
    [{ accountType: 'LIVE' }, 'NOT_CTRADER_DEMO'],
    [{ brokerId: 'mt5' }, 'NOT_CTRADER_DEMO'],
    [{ providerDealId: null }, 'MISSING_PROVIDER_DEAL'],
    [{ brokerLotsBefore: null }, 'UNVERIFIED_VOLUME'],
    [{ brokerLotsAfter: null }, 'UNVERIFIED_VOLUME'],
    [{ brokerLotsAfter: '0.0000' }, 'UNVERIFIED_VOLUME'],
    [{ brokerFilledLots: '0.0200' }, 'PARTIAL_VOLUME_MISMATCH'],
    [{ brokerLotsBefore: '0.0300' }, 'PARTIAL_VOLUME_MISMATCH'],
    [{ brokerLotsBefore: '0.0150' }, 'PARTIAL_VOLUME_MISMATCH'],
    [{ requestedCloseLots: '0.0050' }, 'UNVERIFIED_VOLUME'],
    [{ brokerLotsAfter: '0.0200' }, 'VOLUME_CONSERVATION_FAILED'],
    [{ grossRealisedPnl: null }, 'INCOMPLETE_BROKER_ECONOMICS'],
    [{ commission: null }, 'INCOMPLETE_BROKER_ECONOMICS'],
    [{ swap: null }, 'INCOMPLETE_BROKER_ECONOMICS'],
    [{ accountCurrency: 'eur' }, 'INCOMPLETE_BROKER_ECONOMICS'],
    [{ requestedCloseLots: '0.0200' }, 'UNVERIFIED_VOLUME'],
    [{ requestedCloseLots: '0.01001' }, 'UNVERIFIED_VOLUME'],
  ] as const)('fails closed for %p with %s', (change, reason) => {
    expect(evaluatePartialCloseProof({ ...input, ...change })).toMatchObject({
      reason,
      providerConfirmed: false,
      canDispatchOrder: false,
    });
  });

  it('rejects duplicate/reporting errors even where apparent prices would profit', () => {
    expect(evaluatePartialCloseProof({ ...input, brokerLotsAfter: '0.0101' })).toMatchObject({
      reason: 'VOLUME_CONSERVATION_FAILED',
      providerConfirmed: false,
    });
  });
});
