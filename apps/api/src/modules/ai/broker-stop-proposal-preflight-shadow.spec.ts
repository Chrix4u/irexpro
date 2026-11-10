import {
  validateBrokerStopProposal,
  verifyBrokerStopReadback,
  type BrokerStopProposal,
  type BrokerStopReadback,
} from './broker-stop-proposal-preflight-shadow';

const now = new Date('2026-11-10T12:55:00.000Z');
const buy: BrokerStopProposal = {
  userId: 'owner-7',
  connectionId: 'demo-conn-9',
  brokerId: 'pepperstone-ctrader',
  accountType: 'DEMO',
  expectedPositionId: 'position-417',
  expectedInstrument: 'EURUSD',
  expectedDirection: 'BUY',
  expectedVolumeLots: '4.0000',
  proposedStopLoss: '1.10050',
  proposedTakeProfit: '1.10200',
  quote: {
    connectionId: 'demo-conn-9',
    instrument: 'EURUSD',
    source: 'ctrader-broker-native',
    bid: '1.10100',
    ask: '1.10102',
    observedAt: '2026-11-10T12:54:59.000Z',
  },
  snapshot: {
    ownerUserId: 'owner-7',
    connectionId: 'demo-conn-9',
    positionId: 'position-417',
    instrument: 'EURUSD',
    direction: 'BUY',
    volumeLots: '4.0',
    status: 'OPEN',
    entryPrice: '1.10000',
    stopLoss: '1.09900',
    takeProfit: '1.10200',
  },
  symbol: {
    brokerMetadataVerified: true,
    digits: 5,
    tickSize: '0.00001',
    minStopDistance: '0.00010',
    verifiedCostBufferPrice: '0.00020',
  },
};
const sell: BrokerStopProposal = {
  ...buy,
  expectedInstrument: 'AUDUSD',
  expectedDirection: 'SELL',
  proposedStopLoss: '0.69100',
  proposedTakeProfit: '0.69068',
  quote: {
    ...buy.quote,
    instrument: 'AUDUSD',
    bid: '0.69078',
    ask: '0.69080',
  },
  snapshot: {
    ...buy.snapshot,
    instrument: 'AUDUSD',
    direction: 'SELL',
    entryPrice: '0.69146',
    stopLoss: '0.69198',
    takeProfit: '0.69068',
  },
};
const preflight = (patch: Partial<BrokerStopProposal> = {}) =>
  validateBrokerStopProposal({ ...buy, ...patch }, now);
const accepted: BrokerStopReadback = {
  acceptedByBroker: true,
  expectedConnectionId: 'demo-conn-9',
  expectedPositionId: 'position-417',
  requestedAt: '2026-11-10T12:55:01.000Z',
  ackAt: '2026-11-10T12:55:02.000Z',
  observedAt: '2026-11-10T12:55:03.000Z',
  observedConnectionId: 'demo-conn-9',
  observedPositionId: 'position-417',
  observedStatus: 'OPEN',
  observedStopLoss: '1.1005',
  observedTakeProfit: '1.102',
  freshAuthenticatedBrokerRead: true,
};
const readBackAt = new Date('2026-11-10T12:55:04.000Z');

describe('non-executing broker-held profit-lock preflight', () => {
  it('permits a structurally valid BUY proposal, but never authorizes a broker write', () => {
    const r = preflight();
    expect(r).toMatchObject({
      executionAuthority: 'NONE',
      brokerWriteAuthorized: false,
      autoPromotionEnabled: false,
      structurallyValid: true,
      brokerStopConfirmed: false,
      blockers: [],
      candidate: { newStopLoss: '1.10050', newTakeProfit: '1.10200' },
    });
  });

  it('permits a SELL proposal only with a tighter stop above executable ASK', () => {
    const r = validateBrokerStopProposal(sell, now);
    expect(r.structurallyValid).toBe(true);
    expect(r.candidate?.newTakeProfit).toBe(sell.snapshot.takeProfit);
  });

  it('never widens a BUY or SELL stop, even when profit has previously been protected', () => {
    expect(preflight({ proposedStopLoss: '1.09880' }).blockers).toContain('STOP_NOT_IMPROVED');
    expect(
      validateBrokerStopProposal({ ...sell, proposedStopLoss: '0.69201' }, now).blockers,
    ).toContain('STOP_NOT_IMPROVED');
    // The stop may have already been moved above entry; further tightening
    // is legitimate and must not be mistaken for an initial hard SL.
    expect(
      preflight({
        snapshot: { ...buy.snapshot, stopLoss: '1.10030' },
      }).structurallyValid,
    ).toBe(true);
  });

  it('requires a strictly after-cost gain instead of considering gross breakeven protected', () => {
    expect(preflight({ proposedStopLoss: '1.10020' }).blockers).toContain(
      'STOP_DOES_NOT_SECURE_AFTER_COST_PROFIT',
    );
    expect(
      validateBrokerStopProposal(
        {
          ...sell,
          proposedStopLoss: '0.69126',
        },
        now,
      ).blockers,
    ).toContain('STOP_DOES_NOT_SECURE_AFTER_COST_PROFIT');
  });

  it('fails closed when the conservative broker fee buffer is absent or unverified', () => {
    for (const buffer of ['', '0', '-0.00010', '0.000001']) {
      const result = preflight({
        symbol: { ...buy.symbol, verifiedCostBufferPrice: buffer },
      });
      expect(result.structurallyValid).toBe(false);
      expect(result.candidate).toBeNull();
      expect(
        result.blockers.some(
          (reason) =>
            reason === 'STOP_PRECISION_OR_TICK_INVALID' || reason === 'MALFORMED_PRICE_OR_VOLUME',
        ),
      ).toBe(true);
    }
  });

  it('keeps the stop outside the broker minimum executable stop-distance envelope', () => {
    expect(preflight({ proposedStopLoss: '1.10091' }).blockers).toContain(
      'STOP_TOO_CLOSE_TO_EXECUTABLE_QUOTE',
    );
    expect(
      validateBrokerStopProposal(
        {
          ...sell,
          proposedStopLoss: '0.69090',
        },
        now,
      ).blockers,
    ).toContain('STOP_TOO_CLOSE_TO_EXECUTABLE_QUOTE');
  });

  it('refuses attempts to remove, alter or exceed original TP', () => {
    expect(preflight({ proposedTakeProfit: '1.10190' }).blockers).toContain(
      'TP_CHANGED_OR_POSITION_ALREADY_AT_TP',
    );
    expect(preflight({ proposedTakeProfit: '' }).structurallyValid).toBe(false);
    expect(
      preflight({
        quote: { ...buy.quote, bid: '1.10210', ask: '1.10212' },
      }).blockers,
    ).toContain('TP_CHANGED_OR_POSITION_ALREADY_AT_TP');
  });

  it('refuses stale, synthetic, future, inverted or cross-connection quote data', () => {
    for (const patch of [
      { source: 'synthetic' },
      { observedAt: '2026-11-10T12:54:55.000Z' },
      { observedAt: '2026-11-10T12:55:01.000Z' },
      { bid: '1.10102', ask: '1.10100' },
    ]) {
      expect(preflight({ quote: { ...buy.quote, ...patch } }).blockers).toContain(
        'QUOTE_INVALID_OR_STALE',
      );
    }
    expect(preflight({ quote: { ...buy.quote, connectionId: 'other-broker' } }).blockers).toContain(
      'IDENTITY_OR_EXPOSURE_MISMATCH',
    );
  });

  it('refuses LIVE, unknown broker, wrong user, position id, side, size or closed position', () => {
    expect(preflight({ accountType: 'LIVE' }).blockers).toContain('LIVE_OR_UNSUPPORTED_BROKER');
    expect(preflight({ brokerId: 'direct-mt5' }).blockers).toContain('LIVE_OR_UNSUPPORTED_BROKER');
    for (const patch of [
      { ownerUserId: 'another-user' },
      { positionId: 'another-trade' },
      { instrument: 'USDJPY' },
      { direction: 'SELL' as const },
      { volumeLots: '3.0000' },
      { connectionId: 'another-account' },
    ]) {
      expect(preflight({ snapshot: { ...buy.snapshot, ...patch } }).blockers).toContain(
        'IDENTITY_OR_EXPOSURE_MISMATCH',
      );
    }
    expect(preflight({ snapshot: { ...buy.snapshot, status: 'CLOSED' } }).blockers).toContain(
      'POSITION_NOT_OPEN',
    );
  });

  it('requires broker-verified symbol tick and precision; never rounds in a dangerous direction', () => {
    expect(
      preflight({
        symbol: { ...buy.symbol, brokerMetadataVerified: false },
      }).blockers,
    ).toContain('BROKER_SYMBOL_METADATA_UNVERIFIED');
    expect(preflight({ proposedStopLoss: '1.100505' }).blockers).toContain(
      'MALFORMED_PRICE_OR_VOLUME',
    );
    expect(
      preflight({
        symbol: { ...buy.symbol, tickSize: '0.00003' },
      }).blockers,
    ).toContain('STOP_PRECISION_OR_TICK_INVALID');
    expect(
      preflight({
        symbol: { ...buy.symbol, minStopDistance: '0' },
      }).blockers,
    ).toContain('STOP_PRECISION_OR_TICK_INVALID');
  });

  it('does not call a broker or claim protection when structurally eligible', () => {
    const r = preflight();
    expect(r.brokerStopConfirmed).toBe(false);
    expect(r.brokerWriteAuthorized).toBe(false);
    expect(r.candidate?.newStopLoss).toBe('1.10050');
  });
});

describe('broker-held stop requires affirmative broker read-after-write', () => {
  it('confirms only same-account exact-position current stop and unchanged TP after ACK', () => {
    expect(verifyBrokerStopReadback(preflight(), accepted, readBackAt)).toEqual({
      brokerStopConfirmed: true,
      reason: 'BROKER_READBACK_MATCHED',
    });
  });

  it('does not accept an amendment acknowledgement without a fresh actual broker position read', () => {
    expect(
      verifyBrokerStopReadback(
        preflight(),
        {
          ...accepted,
          freshAuthenticatedBrokerRead: false,
        },
        readBackAt,
      ),
    ).toMatchObject({
      brokerStopConfirmed: false,
      reason: 'BROKER_IDENTITY_OR_READ_MISMATCH',
    });
  });

  it('rejects timeout, rejected amendment and preflight failure', () => {
    expect(
      verifyBrokerStopReadback(
        preflight(),
        {
          ...accepted,
          acceptedByBroker: false,
        },
        readBackAt,
      ).brokerStopConfirmed,
    ).toBe(false);
    expect(
      verifyBrokerStopReadback(
        preflight({
          proposedStopLoss: '1.09800',
        }),
        accepted,
        readBackAt,
      ).brokerStopConfirmed,
    ).toBe(false);
  });

  it('cannot confirm a stop on a different connection, position or closed position', () => {
    for (const patch of [
      { observedPositionId: 'position-999' },
      { expectedPositionId: 'position-999' },
      { expectedConnectionId: 'demo-conn-77' },
      { observedConnectionId: 'demo-conn-77' },
      { observedStatus: 'CLOSED' as const },
    ]) {
      expect(
        verifyBrokerStopReadback(preflight(), { ...accepted, ...patch }, readBackAt),
      ).toMatchObject({ brokerStopConfirmed: false, reason: 'BROKER_IDENTITY_OR_READ_MISMATCH' });
    }
  });

  it('rejects stale readbacks, pre-ack snapshots and future snapshots', () => {
    for (const patch of [
      { observedAt: '2026-11-10T12:55:01.000Z' },
      { observedAt: '2026-11-10T12:54:59.000Z' },
      { observedAt: '2026-11-10T12:55:05.000Z' },
    ]) {
      expect(
        verifyBrokerStopReadback(preflight(), { ...accepted, ...patch }, readBackAt),
      ).toMatchObject({ brokerStopConfirmed: false, reason: 'READBACK_NOT_AFTER_ACK' });
    }
    expect(
      verifyBrokerStopReadback(preflight(), accepted, new Date('2026-11-10T12:55:10Z')),
    ).toMatchObject({ brokerStopConfirmed: false, reason: 'READBACK_NOT_AFTER_ACK' });
  });

  it('never claims profit protected if stop was not installed or TP changed at broker', () => {
    for (const patch of [
      { observedStopLoss: '1.09900' },
      { observedTakeProfit: '1.10180' },
      { observedStopLoss: '' },
    ]) {
      expect(
        verifyBrokerStopReadback(preflight(), { ...accepted, ...patch }, readBackAt),
      ).toMatchObject({ brokerStopConfirmed: false, reason: 'BROKER_STOP_OR_TP_NOT_CONFIRMED' });
    }
  });
});
