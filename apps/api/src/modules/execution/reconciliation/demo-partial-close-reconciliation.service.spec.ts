import { DataSource } from 'typeorm';
import {
  CtraderPartialLegObservation,
  DemoPartialCloseReconciliationService,
} from './demo-partial-close-reconciliation.service';

const leg = {
  id: 'leg-1',
  state: 'DISPATCHING',
  broker_connection_id: 'connection-1',
  broker_position_id: 'position-101',
  account_currency: 'EUR',
  original_lots: '0.0200',
  requested_close_lots: '0.0100',
  provider_order_id: null,
  provider_deal_id: null,
  broker_lots_before: null,
  broker_filled_lots: null,
  broker_lots_after: null,
  gross_realised_pnl: null,
  commission: null,
  swap: null,
  economics_complete: false,
  trade_status: 'OPEN',
  trade_account_currency: 'EUR',
  trade_logical_account_key: 'ctrader|broker|account',
  connection_logical_account_key: 'ctrader|broker|account',
  connection_currency: 'EUR',
  broker_id: 'ctrader',
  account_type: 'DEMO',
  current_position_id: 'position-101',
};
const evidence: CtraderPartialLegObservation = {
  brokerPositionId: 'position-101',
  accountCurrency: 'EUR',
  providerOrderId: 'order-11',
  providerDealId: 'deal-12',
  brokerLotsBefore: '0.0200',
  brokerFilledLots: '0.0100',
  brokerLotsAfter: '0.0100',
  grossRealisedPnl: '0.85000000',
  commission: '-0.03000000',
  swap: '0.00000000',
};

function fixture(stored: Record<string, unknown> | null = leg, affected = true) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM trading.trades t')) return stored ? [stored] : [];
    if (sql.includes('UPDATE trading.demo_partial_close_legs')) {
      return affected ? [{ id: 'leg-1' }] : [];
    }
    throw new Error('Unexpected SQL');
  });
  const transaction = jest.fn(async (fn: (m: { query: typeof query }) => Promise<unknown>) =>
    fn({ query }),
  );
  return {
    service: new DemoPartialCloseReconciliationService({ transaction } as unknown as DataSource),
    query,
    transaction,
  };
}

describe('cTrader DEMO partial-close reconciliation without execution', () => {
  it('confirms only complete deal/volume/fee evidence under tenant and trade locks', async () => {
    const { service, query, transaction } = fixture();
    expect(await service.recordBrokerObservation('user-1', 'leg-1', evidence)).toEqual({
      ledgerId: 'leg-1',
      state: 'CONFIRMED',
      reason: 'CONFIRMED',
      idempotent: false,
      economicsComplete: true,
      remainingLots: '0.0100',
      canDispatchOrder: false,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t, l');
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'leg-1']);
    expect(query.mock.calls[1][0]).toContain("SET state = 'CONFIRMED'");
    expect(query.mock.calls[1][0]).toContain('economics_complete = TRUE');
    expect(query.mock.calls[1][1]).toEqual([
      'leg-1',
      'user-1',
      'order-11',
      'deal-12',
      '0.0200',
      '0.0100',
      '0.0100',
      '0.85000000',
      '-0.03000000',
      '0.00000000',
    ]);
  });

  it.each([
    [{ providerDealId: null }, 'MISSING_PROVIDER_DEAL'],
    [{ brokerLotsBefore: null }, 'UNVERIFIED_VOLUME'],
    [{ brokerLotsAfter: null }, 'UNVERIFIED_VOLUME'],
    [{ brokerLotsAfter: '0.0090' }, 'VOLUME_CONSERVATION_FAILED'],
    [{ brokerFilledLots: '0.0050' }, 'PARTIAL_VOLUME_MISMATCH'],
    [{ commission: null }, 'INCOMPLETE_BROKER_ECONOMICS'],
    [{ grossRealisedPnl: null }, 'INCOMPLETE_BROKER_ECONOMICS'],
    [{ swap: null }, 'INCOMPLETE_BROKER_ECONOMICS'],
  ])('persists uncertainty for %p (%s) and never fabricates P&L', async (patch, reason) => {
    const { service, query } = fixture();
    expect(
      await service.recordBrokerObservation('user-1', 'leg-1', { ...evidence, ...patch }),
    ).toMatchObject({
      state: 'RECONCILIATION_PENDING',
      reason,
      economicsComplete: false,
      remainingLots: null,
      canDispatchOrder: false,
    });
    expect(query.mock.calls[1][0]).toContain("state = 'RECONCILIATION_PENDING'");
    expect(query.mock.calls[1][0]).not.toContain('gross_realised_pnl =');
  });

  it.each([
    [null, 'unowned ledger'],
    [{ ...leg, broker_id: 'direct-mt5' }, 'non-cTrader broker'],
    [{ ...leg, account_type: 'LIVE' }, 'LIVE account'],
    [{ ...leg, connection_currency: 'USD' }, 'switched account currency'],
    [{ ...leg, trade_logical_account_key: 'other' }, 'switched logical identity'],
    [{ ...leg, trade_account_currency: 'USD' }, 'trade currency mismatch'],
    [{ ...leg, current_position_id: 'position-200' }, 'different position'],
  ])('refuses %p (%s)', async (stored, _description) => {
    const { service, query } = fixture(stored);
    await expect(service.recordBrokerObservation('user-1', 'leg-1', evidence)).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses wrong broker position from caller', async () => {
    const { service, query } = fixture();
    await expect(
      service.recordBrokerObservation('user-1', 'leg-1', {
        ...evidence,
        brokerPositionId: 'wrong-position',
      }),
    ).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['RESERVED', 'REJECTED'])('does not reconcile an uncommitted %s leg', async (state) => {
    const { service, query } = fixture({ ...leg, state });
    await expect(service.recordBrokerObservation('user-1', 'leg-1', evidence)).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('can converge a pending leg after fees become available, even if trading session ended', async () => {
    const { service } = fixture({ ...leg, state: 'RECONCILIATION_PENDING' });
    expect(await service.recordBrokerObservation('user-1', 'leg-1', evidence)).toMatchObject({
      state: 'CONFIRMED',
      economicsComplete: true,
    });
  });

  it('returns idempotently on the same already-confirmed provider event without a new write', async () => {
    const { service, query } = fixture({
      ...leg,
      state: 'CONFIRMED',
      provider_order_id: evidence.providerOrderId,
      provider_deal_id: evidence.providerDealId,
      broker_lots_before: evidence.brokerLotsBefore,
      broker_filled_lots: evidence.brokerFilledLots,
      broker_lots_after: evidence.brokerLotsAfter,
      gross_realised_pnl: evidence.grossRealisedPnl,
      commission: evidence.commission,
      swap: evidence.swap,
      economics_complete: true,
      trade_status: 'CLOSED',
    });
    expect(await service.recordBrokerObservation('user-1', 'leg-1', evidence)).toMatchObject({
      state: 'CONFIRMED',
      idempotent: true,
      canDispatchOrder: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('prevents overwriting confirmed economics with a conflicting broker event', async () => {
    const { service, query } = fixture({
      ...leg,
      state: 'CONFIRMED',
      provider_order_id: evidence.providerOrderId,
      provider_deal_id: evidence.providerDealId,
      broker_lots_before: evidence.brokerLotsBefore,
      broker_filled_lots: evidence.brokerFilledLots,
      broker_lots_after: evidence.brokerLotsAfter,
      gross_realised_pnl: evidence.grossRealisedPnl,
      commission: evidence.commission,
      swap: evidence.swap,
      economics_complete: true,
    });
    await expect(
      service.recordBrokerObservation('user-1', 'leg-1', {
        ...evidence,
        grossRealisedPnl: '1.50000000',
      }),
    ).rejects.toThrow('Conflicting broker evidence');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a concurrent CAS miss and never reports confirmation', async () => {
    const { service } = fixture(leg, false);
    await expect(service.recordBrokerObservation('user-1', 'leg-1', evidence)).rejects.toThrow(
      'ledger state changed',
    );
  });

  it('rejects economic proof for an already closed trade unless already confirmed', async () => {
    const { service, query } = fixture({ ...leg, trade_status: 'CLOSED' });
    await expect(service.recordBrokerObservation('user-1', 'leg-1', evidence)).rejects.toThrow(
      'incompatible lifecycle',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
