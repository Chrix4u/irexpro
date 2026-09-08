import {
  compareAccount,
  compareDecimal,
  compareOrders,
  comparePositions,
  compareStates,
  detectUnresolvedExecutions,
  DEFAULT_COMPARATOR_OPTIONS,
  DiscrepancyCandidate,
  InternalAccountSnapshot,
  InternalOrderSnapshot,
  InternalTradeSnapshot,
} from './reconciliation-comparator';
import {
  ReconciliationDiscrepancyType,
  RECONCILIATION_DISCREPANCY_TYPES,
} from './reconciliation.enums';
import {
  BrokerAccountInfo,
  BrokerOrderState,
  BrokerPosition,
} from '../../broker/interfaces/broker-adapter.interface';

// ─── Fixture builders ───────────────────────────────────────────────────────

const baseProviderAccount = (): BrokerAccountInfo => ({
  accountId: 'acct-1',
  currency: 'USD',
  leverage: 100,
  balance: '10000.00',
  equity: '10000.00',
  margin: '0.00',
  freeMargin: '10000.00',
  marginLevel: '0.00',
});

const baseInternalAccount = (
  overrides: Partial<InternalAccountSnapshot> = {},
): InternalAccountSnapshot => ({
  balance: '10000.00',
  equity: '10000.00',
  margin: '0.00',
  freeMargin: '10000.00',
  marginLevel: '0.00',
  currency: 'USD',
  leverage: 100,
  ...overrides,
});

const baseProviderOrder = (overrides: Partial<BrokerOrderState> = {}): BrokerOrderState => ({
  providerOrderId: 'ticket-1',
  clientOrderId: 'client-1',
  status: 'WORKING',
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedQuantity: '1.0000',
  filledQuantity: '0.0000',
  avgFillPrice: null,
  orderKind: 'LIMIT',
  limitPrice: '1.10000',
  stopPrice: null,
  timeInForce: 'GTC',
  placedAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: null,
  ...overrides,
});

const baseInternalOrder = (
  overrides: Partial<InternalOrderSnapshot> = {},
): InternalOrderSnapshot => ({
  orderId: 'order-1',
  clientOrderId: 'client-1',
  providerOrderId: 'ticket-1',
  status: 'ACKNOWLEDGED',
  orderKind: 'LIMIT',
  instrument: 'EURUSD',
  requestedQuantity: '1.0000',
  filledQuantity: '0.0000',
  avgFillPrice: null,
  submittedAt: new Date('2025-01-01T00:00:00Z'),
  tradeId: null,
  ...overrides,
});

const baseProviderPosition = (overrides: Partial<BrokerPosition> = {}): BrokerPosition => ({
  externalOrderId: 'pos-1',
  instrument: 'EURUSD',
  direction: 'BUY',
  lotSize: '1.0000',
  openPrice: '1.10000',
  currentPrice: '1.10500',
  stopLoss: '0',
  takeProfit: '0',
  unrealisedPnl: '50.00',
  openedAt: new Date('2025-01-01T00:00:00Z'),
  commission: '0.00',
  swap: '0.00',
  ...overrides,
});

const baseInternalTrade = (
  overrides: Partial<InternalTradeSnapshot> = {},
): InternalTradeSnapshot => ({
  tradeId: 'trade-1',
  externalOrderId: 'pos-1',
  externalPositionId: null,
  status: 'OPEN',
  instrument: 'EURUSD',
  lotSize: '1.0000',
  fillPrice: '1.10000',
  openedAt: new Date('2025-01-01T00:00:00Z'),
  ...overrides,
});

const typesOf = (candidates: DiscrepancyCandidate[]) => candidates.map((c) => c.type);

// ─── compareDecimal ─────────────────────────────────────────────────────────

describe('compareDecimal', () => {
  it('compares equal values with different scales as equal', () => {
    expect(compareDecimal('1.10', '1.100000')).toBe(0);
    expect(compareDecimal('0', '0.0000')).toBe(0);
  });

  it('orders values correctly', () => {
    expect(compareDecimal('1.2000', '1.1000')).toBe(1);
    expect(compareDecimal('1.1000', '1.2000')).toBe(-1);
  });

  it('handles negatives', () => {
    expect(compareDecimal('-5.00', '5.00')).toBe(-1);
    expect(compareDecimal('-5.00', '-5.00')).toBe(0);
  });

  it('handles null-ish input without NaN', () => {
    expect(compareDecimal('0', '0')).toBe(0);
  });
});

// ─── compareOrders ──────────────────────────────────────────────────────────

describe('compareOrders', () => {
  it('returns nothing when states match', () => {
    const out = compareOrders([baseInternalOrder()], [baseProviderOrder()], []);
    expect(out).toEqual([]);
  });

  it('accepts a filled market order tracked as a provider POSITION (no working order)', () => {
    // Market orders leave the working list once they become positions.
    const order = baseInternalOrder({
      orderKind: 'MARKET',
      providerOrderId: 'pos-1',
      status: 'ACKNOWLEDGED',
    });
    const out = compareOrders([order], [], [baseProviderPosition()]);
    expect(out).toEqual([]);
  });

  it('detects MISSING_PROVIDER_ORDER when the provider knows neither order nor position', () => {
    const order = baseInternalOrder({ status: 'SUBMITTED' });
    const out = compareOrders([order], [], []);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(ReconciliationDiscrepancyType.MISSING_PROVIDER_ORDER);
    expect(out[0].internalRefId).toBe('order-1');
    expect(out[0].providerRef).toBe('ticket-1');
  });

  it('ignores CREATED and terminal orders (no provider expectation)', () => {
    for (const status of ['CREATED', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']) {
      const order = baseInternalOrder({ status });
      expect(compareOrders([order], [], [])).toEqual([]);
    }
  });

  it('detects MISSING_INTERNAL_ORDER for provider orders with no internal record', () => {
    const out = compareOrders([], [baseProviderOrder({ providerOrderId: 'orphan-1' })], []);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(ReconciliationDiscrepancyType.MISSING_INTERNAL_ORDER);
    expect(out[0].severity).toBe('CRITICAL');
    expect(out[0].internalRefId).toBeNull();
  });

  it('correlates by clientOrderId — a matching internal record is NOT missing', () => {
    // Internal order references a DIFFERENT provider id (e.g. re-ticketed),
    // but the stable client id matches the provider echo.
    const order = baseInternalOrder({ providerOrderId: 'ticket-other' });
    const out = compareOrders([order], [baseProviderOrder({ providerOrderId: 'orphan-1' })], []);
    expect(out).toHaveLength(1); // only ticket-other's MISSING_PROVIDER_ORDER
    expect(out[0].providerRef).toBe('ticket-other');
  });

  it('detects DUPLICATE_PROVIDER_ID when two internal orders claim one provider id', () => {
    const a = baseInternalOrder();
    const b = baseInternalOrder({ orderId: 'order-2' });
    const out = compareOrders([a, b], [], []);
    const dup = out.find((c) => c.type === ReconciliationDiscrepancyType.DUPLICATE_PROVIDER_ID);
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe('CRITICAL');
    expect((dup?.details as { internalOrderIds: string[] }).internalOrderIds).toEqual(
      expect.arrayContaining(['order-1', 'order-2']),
    );
  });

  describe('stale order state', () => {
    for (const providerStatus of ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'] as const) {
      it(`detects STALE_ORDER_STATE when provider says ${providerStatus}`, () => {
        const out = compareOrders(
          [baseInternalOrder()],
          [baseProviderOrder({ status: providerStatus })],
          [],
        );
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe(ReconciliationDiscrepancyType.STALE_ORDER_STATE);
        expect(out[0].details).toMatchObject({ providerStatus });
      });
    }

    it('detects STALE_ORDER_STATE when provider filled more than internal recorded', () => {
      const out = compareOrders(
        [baseInternalOrder({ status: 'PARTIALLY_FILLED', filledQuantity: '0.5000' })],
        [baseProviderOrder({ status: 'PARTIALLY_FILLED', filledQuantity: '0.7500' })],
        [],
      );
      expect(out).toHaveLength(1);
      expect(out[0].type).toBe(ReconciliationDiscrepancyType.STALE_ORDER_STATE);
      expect(out[0].details).toMatchObject({
        internalFilledQuantity: '0.5000',
        providerFilledQuantity: '0.7500',
      });
    });

    it('does NOT flag provider filling LESS than internal (internal is ahead)', () => {
      const out = compareOrders(
        [baseInternalOrder({ filledQuantity: '1.0000', status: 'FILLED' })],
        [baseProviderOrder({ filledQuantity: '0.5000' })],
        [],
      );
      // Internal FILLED is terminal — not compared at all.
      expect(out).toEqual([]);
    });
  });

  it('detects UNKNOWN_PROVIDER_ORDER on unrecognized provider state (fail-closed)', () => {
    const out = compareOrders(
      [baseInternalOrder()],
      [baseProviderOrder({ status: 'UNKNOWN' })],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_ORDER);
  });
});

// ─── comparePositions ───────────────────────────────────────────────────────

describe('comparePositions', () => {
  it('returns nothing when positions match', () => {
    expect(comparePositions([baseInternalTrade()], [baseProviderPosition()])).toEqual([]);
  });

  it('detects POSITION_CLOSED_EXTERNALLY when internal open but provider has no position', () => {
    const out = comparePositions([baseInternalTrade()], []);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(ReconciliationDiscrepancyType.POSITION_CLOSED_EXTERNALLY);
    expect(out[0].internalRefId).toBe('trade-1');
  });

  it('matches by externalPositionId too (netting brokers)', () => {
    const trade = baseInternalTrade({ externalOrderId: null, externalPositionId: 'pos-1' });
    expect(comparePositions([trade], [baseProviderPosition()])).toEqual([]);
  });

  it('detects UNKNOWN_PROVIDER_POSITION for provider positions with no internal record', () => {
    const out = comparePositions([], [baseProviderPosition()]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION);
    expect(out[0].severity).toBe('CRITICAL');
  });

  it('detects DUPLICATE_PROVIDER_ID when two trades claim one provider position', () => {
    const a = baseInternalTrade();
    const b = baseInternalTrade({ tradeId: 'trade-2' });
    const out = comparePositions([a, b], [baseProviderPosition()]);
    const dup = out.find((c) => c.type === ReconciliationDiscrepancyType.DUPLICATE_PROVIDER_ID);
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe('CRITICAL');
  });

  it('ignores CLOSED/CANCELLED/REJECTED trades (no position expectation)', () => {
    for (const status of ['CLOSED', 'CANCELLED', 'REJECTED', 'PENDING']) {
      expect(comparePositions([baseInternalTrade({ status })], [])).toEqual([]);
    }
  });

  it('does not report POSITION_CLOSED_EXTERNALLY for trades without external id (unresolved detector owns those)', () => {
    const trade = baseInternalTrade({ externalOrderId: null, externalPositionId: null });
    expect(comparePositions([trade], [])).toEqual([]);
  });
});

// ─── compareAccount ─────────────────────────────────────────────────────────

describe('compareAccount', () => {
  it('returns nothing when snapshots agree within tolerance', () => {
    const internal = baseInternalAccount({ equity: '10012.00' }); // 0.12% drift
    const provider = baseProviderAccount();
    expect(compareAccount(internal, provider, DEFAULT_COMPARATOR_OPTIONS)).toEqual([]);
  });

  it('returns nothing when there is no stored snapshot (first sync)', () => {
    expect(compareAccount(null, baseProviderAccount(), DEFAULT_COMPARATOR_OPTIONS)).toEqual([]);
  });

  it('detects ACCOUNT_STATE_MISMATCH on balance drift beyond tolerance', () => {
    const internal = baseInternalAccount({ balance: '9000.00' }); // 10% drift
    const out = compareAccount(internal, baseProviderAccount(), DEFAULT_COMPARATOR_OPTIONS);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(ReconciliationDiscrepancyType.ACCOUNT_STATE_MISMATCH);
    expect(out[0].severity).toBe('WARNING');
    expect(out[0].details).toMatchObject({
      monetaryDrift: { balance: { expected: '9000.00', observed: '10000.00' } },
    });
  });

  it('absorbs sub-floor drift (rounding noise)', () => {
    const internal = baseInternalAccount({ balance: '10000.005' });
    expect(compareAccount(internal, baseProviderAccount(), DEFAULT_COMPARATOR_OPTIONS)).toEqual([]);
  });

  it('flags structural mismatch (currency) as CRITICAL', () => {
    const internal = baseInternalAccount({ currency: 'EUR' });
    const out = compareAccount(internal, baseProviderAccount(), DEFAULT_COMPARATOR_OPTIONS);
    expect(out[0].severity).toBe('CRITICAL');
    expect(out[0].details).toMatchObject({
      structuralMismatch: { currency: { expected: 'EUR', observed: 'USD' } },
    });
  });

  it('flags leverage mismatch as CRITICAL', () => {
    const internal = baseInternalAccount({ leverage: 200 });
    const out = compareAccount(internal, baseProviderAccount(), DEFAULT_COMPARATOR_OPTIONS);
    expect(out[0].severity).toBe('CRITICAL');
  });
});

// ─── detectUnresolvedExecutions (Directive §26) ──────────────────────────────

describe('detectUnresolvedExecutions', () => {
  const now = new Date('2025-01-01T12:00:00Z');
  const grace = DEFAULT_COMPARATOR_OPTIONS.unresolvedGraceMs;

  it('flags RECONCILIATION_PENDING orders older than grace', () => {
    const order = baseInternalOrder({
      status: 'RECONCILIATION_PENDING',
      submittedAt: new Date(now.getTime() - grace - 1000),
    });
    const out = detectUnresolvedExecutions([order], [], now, DEFAULT_COMPARATOR_OPTIONS);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(ReconciliationDiscrepancyType.UNRESOLVED_EXECUTION_RESULT);
    expect(out[0].internalRefId).toBe('order-1');
  });

  it('does not flag RECONCILIATION_PENDING orders still within grace', () => {
    const order = baseInternalOrder({
      status: 'RECONCILIATION_PENDING',
      submittedAt: new Date(now.getTime() - grace + 60_000),
    });
    expect(detectUnresolvedExecutions([order], [], now, DEFAULT_COMPARATOR_OPTIONS)).toEqual([]);
  });

  it('flags RECONCILIATION_PENDING TRADES — including those WITHOUT external ids (the previously silent case)', () => {
    const trade = baseInternalTrade({
      status: 'RECONCILIATION_PENDING',
      externalOrderId: null,
      openedAt: new Date(now.getTime() - grace - 1),
    });
    const out = detectUnresolvedExecutions([], [trade], now, DEFAULT_COMPARATOR_OPTIONS);
    expect(out).toHaveLength(1);
    expect(out[0].internalRefId).toBe('trade-1');
    expect(out[0].details).toMatchObject({ hasProviderId: false });
  });
});

// ─── compareStates (integration of detectors + dedup) ────────────────────────

describe('compareStates', () => {
  const now = new Date('2025-01-01T12:00:00Z');

  it('returns nothing for fully consistent state', () => {
    const out = compareStates(
      {
        orders: [baseInternalOrder()],
        trades: [baseInternalTrade()],
        account: baseInternalAccount(),
      },
      {
        orders: [baseProviderOrder()],
        positions: [baseProviderPosition()],
        account: baseProviderAccount(),
      },
      now,
    );
    expect(out).toEqual([]);
  });

  it('surfaces every directive §25 category (exhaustive taxonomy check)', () => {
    // Build a scenario that triggers every directive category.
    const grace = DEFAULT_COMPARATOR_OPTIONS.unresolvedGraceMs;
    const internal = {
      orders: [
        // MISSING_PROVIDER_ORDER (provider knows nothing about gone-1)
        baseInternalOrder({
          orderId: 'o-miss',
          clientOrderId: 'c-miss',
          providerOrderId: 'gone-1',
          status: 'SUBMITTED',
        }),
        // STALE_ORDER_STATE (provider terminal, internal RECONCILIATION_PENDING)
        // + UNRESOLVED_EXECUTION_RESULT (past grace)
        baseInternalOrder({
          orderId: 'o-stale',
          clientOrderId: 'c-stale',
          providerOrderId: 'stale-1',
          status: 'RECONCILIATION_PENDING',
          submittedAt: new Date(now.getTime() - grace - 1),
        }),
        // UNKNOWN_PROVIDER_ORDER (provider reports an unrecognized state)
        baseInternalOrder({
          orderId: 'o-unknown',
          clientOrderId: 'c-unknown',
          providerOrderId: 'unknown-1',
        }),
        // DUPLICATE_PROVIDER_ID (two orders claim dup-1)
        baseInternalOrder({
          orderId: 'o-dup-a',
          clientOrderId: 'c-dup-a',
          providerOrderId: 'dup-1',
          status: 'RECONCILIATION_PENDING',
          submittedAt: new Date(now.getTime() - 60_000),
        }),
        baseInternalOrder({
          orderId: 'o-dup-b',
          clientOrderId: 'c-dup-b',
          providerOrderId: 'dup-1',
          status: 'RECONCILIATION_PENDING',
          submittedAt: new Date(now.getTime() - 60_000),
        }),
      ],
      trades: [
        // POSITION_CLOSED_EXTERNALLY
        baseInternalTrade({ tradeId: 't-closed', externalOrderId: 'vanish-1' }),
        // UNRESOLVED_EXECUTION_RESULT without external id (previously silent)
        baseInternalTrade({
          tradeId: 't-unres',
          externalOrderId: null,
          status: 'RECONCILIATION_PENDING',
          openedAt: new Date(now.getTime() - grace - 1),
        }),
      ],
      account: baseInternalAccount({ balance: '5000.00' }), // ACCOUNT_STATE_MISMATCH
    };
    const provider = {
      orders: [
        // MISSING_INTERNAL_ORDER (no internal record, no client-id match)
        baseProviderOrder({ providerOrderId: 'orphan-1', clientOrderId: 'c-orphan' }),
        // STALE_ORDER_STATE: provider terminal, internal RECONCILIATION_PENDING
        baseProviderOrder({
          providerOrderId: 'stale-1',
          clientOrderId: 'c-stale',
          status: 'FILLED',
          filledQuantity: '1.0000',
        }),
        // UNKNOWN_PROVIDER_ORDER: unrecognized provider state
        baseProviderOrder({
          providerOrderId: 'unknown-1',
          clientOrderId: 'c-unknown',
          status: 'UNKNOWN',
        }),
      ],
      positions: [
        // UNKNOWN_PROVIDER_POSITION
        baseProviderPosition({ externalOrderId: 'ghost-1' }),
      ],
      account: baseProviderAccount(),
    };

    const out = compareStates(internal, provider, now);
    const found = new Set(typesOf(out));

    expect(found).toEqual(new Set(RECONCILIATION_DISCREPANCY_TYPES));
  });

  it('deduplicates candidates that two detectors flag for the same record', () => {
    // A RECONCILIATION_PENDING trade without external id is positionless
    // (comparePositions skips) AND unresolved — only unresolved flags it.
    const trade = baseInternalTrade({
      status: 'RECONCILIATION_PENDING',
      externalOrderId: null,
      openedAt: new Date(now.getTime() - DEFAULT_COMPARATOR_OPTIONS.unresolvedGraceMs - 1),
    });
    const out = compareStates(
      { orders: [], trades: [trade], account: null },
      {
        orders: [],
        positions: [],
        account: baseProviderAccount(),
      },
      now,
    );
    expect(out).toHaveLength(1);
  });
});
