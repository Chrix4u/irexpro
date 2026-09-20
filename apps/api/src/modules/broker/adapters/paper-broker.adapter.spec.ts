import { Test, TestingModule } from '@nestjs/testing';
import {
  DeterministicPaperClock,
  DeterministicPaperPriceFeed,
  PaperBrokerAdapter,
  PaperClock,
  PaperPriceFeed,
  PaperQuote,
} from './paper-broker.adapter';
import { BrokerAdapterError } from '../interfaces/broker-adapter.errors';
import { BrokerMode, BrokerOrderRequest } from '../interfaces/broker-adapter.interface';

/**
 * PaperBrokerAdapter spec — main's Sprint 50/51 assertions (ALL preserved
 * verbatim) UNION the Sprint 56 paper-lifecycle contract ported from the
 * orphan sprint onto the new-main interface (orderKind unions instead of a
 * BrokerOrderType enum, no adapter-declared capabilities, listOrders/
 * getOrderById as the provider order-state surface, cancelOrder as a
 * CONCRETE method outside IBrokerAdapter).
 *
 * The engine is fully deterministic: the price walk (constructor-injectable
 * PaperPriceFeed) and the clock (PaperClock) are the only seams. The default
 * feed is the classic 1.10000/1.10010 quote advancing +2/−1 pips per tick (a
 * slow upward drift — BUY STOP / SELL LIMIT / BUY TP / SELL SL paths);
 * scripted falling walks exercise the mirrored SELL-side paths.
 *
 * MERGED FILL MODEL (documented): MARKET fills and manual closes execute at
 * the quote MID — the deterministic '1.10005' paper fill pinned by main's
 * historical specs. Working-order fills execute at the prevailing quote side
 * (BUY at ask, SELL at bid — never worse than a resting limit); SL/TP close
 * exactly at their level.
 *
 * All expected money values below are EXACT BigInt decimal-string math
 * results (no floats anywhere near the assertions).
 */

// ─── Deterministic test seams ────────────────────────────────────────────────

/** Scripted quotes: quote() = current, tick() = next (flat when exhausted). */
class ScriptedPaperPriceFeed extends PaperPriceFeed {
  private current: PaperQuote;
  private readonly queue: PaperQuote[];

  constructor(quotes: PaperQuote[]) {
    super();
    this.current = quotes[0]!;
    this.queue = quotes.slice(1);
  }

  quote(): PaperQuote {
    return { ...this.current };
  }

  tick(): PaperQuote {
    const next = this.queue.shift();
    if (next) {
      this.current = next;
    }
    return { ...this.current };
  }
}

class FakePaperClock extends PaperClock {
  private offsetMs = 0;

  constructor(private readonly baseMs: number) {
    super();
  }

  now(): Date {
    return new Date(this.baseMs + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

const BASE: PaperQuote = { bid: '1.10000', ask: '1.10010' };

/** Fixed fake-clock epoch for scripted-feed adapters (arbitrary, stable). */
const CLOCK_BASE_MS = 1_000_000_000;

/** The default deterministic clock epoch (module-instantiated adapters). */
const DEFAULT_CLOCK_EPOCH = Date.UTC(2024, 0, 2, 3, 4, 5);

function scriptedAdapter(quotes: PaperQuote[], baseMs = CLOCK_BASE_MS): PaperBrokerAdapter {
  const adapter = new PaperBrokerAdapter(
    new ScriptedPaperPriceFeed(quotes),
    new FakePaperClock(baseMs),
  );
  void adapter.connect({ accountId: 'paper-account-001' });
  return adapter;
}

function order(overrides: Partial<BrokerOrderRequest>): BrokerOrderRequest {
  return {
    idempotencyKey: 'paper-spec-key',
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '0.10',
    stopLoss: '0',
    takeProfit: '0',
    ...overrides,
  };
}

async function expectAdapterError(
  run: () => Promise<unknown>,
  code: string,
): Promise<BrokerAdapterError> {
  const err = await run().then(
    () => {
      throw new Error('expected the call to reject');
    },
    (rejection) => rejection,
  );
  expect(err).toBeInstanceOf(BrokerAdapterError);
  expect((err as BrokerAdapterError).code).toBe(code);
  return err as BrokerAdapterError;
}

// ─── Core adapter surface (Nest-instantiated, like production) ───────────────

describe('PaperBrokerAdapter', () => {
  let module: TestingModule;
  let adapter: PaperBrokerAdapter;

  const dummyCreds = { accountId: 'test-account' };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [PaperBrokerAdapter],
    }).compile();

    adapter = module.get(PaperBrokerAdapter);
  });

  afterEach(async () => {
    await module.close();
  });

  it('has brokerId = paper-broker', () => {
    expect(adapter.brokerId).toBe('paper-broker');
  });

  it('implements IBrokerAdapter interface', () => {
    expect(typeof adapter.connect).toBe('function');
    expect(typeof adapter.disconnect).toBe('function');
    expect(typeof adapter.placeOrder).toBe('function');
    expect(typeof adapter.getOHLCV).toBe('function');
    expect(typeof adapter.closeAllOrders).toBe('function');
    expect(typeof adapter.getClosedTrades).toBe('function');
  });

  it('exposes the concrete cancel + provider order-state surfaces (beyond IBrokerAdapter)', () => {
    // cancelOrder is a CONCRETE method (the interface carries no cancel
    // surface); listOrders/getOrderById are the interface's order-state reads.
    expect(typeof adapter.cancelOrder).toBe('function');
    expect(typeof adapter.listOrders).toBe('function');
    expect(typeof adapter.getOrderById).toBe('function');
  });

  it('connects without real credentials', async () => {
    const result = await adapter.connect(dummyCreds);
    expect(result.success).toBe(true);
    expect(result.accountType).toBe(BrokerMode.DEMO);
    expect(adapter.isConnected()).toBe(true);
  });

  it('connect returns the deterministic DEMO account identity (clock-driven serverTime)', async () => {
    const result = await adapter.connect(dummyCreds);
    expect(result.accountId).toBe('paper-account-001');
    expect(result.currency).toBe('USD');
    // Default deterministic clock: fixed epoch (no Date.now anywhere).
    expect(result.serverTime.getTime()).toBe(DEFAULT_CLOCK_EPOCH);
  });

  it('testConnection always succeeds without external API call', async () => {
    const result = await adapter.testConnection(dummyCreds);
    expect(result.success).toBe(true);
  });

  it('cannot be set to LIVE mode', () => {
    adapter.setMode(BrokerMode.LIVE);
    // Mode must NOT be LIVE after calling setMode(LIVE)
    // We verify indirectly: connect returns DEMO account type
    adapter.connect(dummyCreds).then((r) => {
      expect(r.accountType).toBe(BrokerMode.DEMO);
    });
  });

  it('placeOrder returns simulated result marked PAPER_ONLY', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder({
      idempotencyKey: 'test-key-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09000',
      takeProfit: '1.11000',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('FILLED');
    expect(result.brokerMessage).toContain('PAPER_ONLY');
    expect(result.externalOrderId).toContain('paper-order');
  });

  // ─── Sprint 50 PR-3 — honest order-kind semantics ─────────────────────────

  it('MARKET orders fill immediately with the requested quantity', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder({
      idempotencyKey: 'test-key-mkt',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.02',
      stopLoss: '1.09000',
      takeProfit: '1.11000',
      orderKind: 'MARKET',
    });
    expect(result.status).toBe('FILLED');
    expect(result.filledQuantity).toBe('0.02');
    expect(result.filledPrice).toBe('1.10005');
  });

  it('LIMIT orders are accepted as WORKING orders (never silently filled)', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder({
      idempotencyKey: 'test-key-lmt',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.01',
      stopLoss: '1.09000',
      takeProfit: '1.11000',
      orderKind: 'LIMIT',
      limitPrice: '1.09500',
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe('PENDING');
    expect(result.brokerMessage).toContain('LIMIT');
    expect(result.filledPrice).toBeUndefined();
  });

  it('STOP/STOP_LIMIT orders are accepted as WORKING orders', async () => {
    await adapter.connect(dummyCreds);
    for (const kind of ['STOP', 'STOP_LIMIT'] as const) {
      const result = await adapter.placeOrder({
        idempotencyKey: `test-key-${kind}`,
        instrument: 'EURUSD',
        direction: 'SELL',
        lotSize: '0.01',
        stopLoss: '1.11000',
        takeProfit: '1.09000',
        orderKind: kind,
        stopPrice: '1.10500',
        limitPrice: kind === 'STOP_LIMIT' ? '1.10450' : undefined,
      });
      expect(result.status).toBe('PENDING');
      expect(result.externalOrderId).toContain('paper-order');
    }
  });

  it('placeOrder never calls external broker API', async () => {
    // PaperBrokerAdapter has no HTTP client — no external call possible.
    // Verify it doesn't throw and returns a local result immediately.
    // (Sprint 51 PR-7: data operations require connect() first — fail closed.)
    await adapter.connect(dummyCreds);
    const start = Date.now();
    const result = await adapter.placeOrder({
      idempotencyKey: 'test-key-2',
      instrument: 'EURUSD',
      direction: 'SELL',
      lotSize: '0.01',
      stopLoss: '1.12000',
      takeProfit: '1.09000',
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(100); // Local only — no network latency
  });

  it('getOHLCV returns deterministic mock candles', async () => {
    await adapter.connect(dummyCreds);
    const candles = await adapter.getOHLCV('EURUSD', 'H1', 10);
    expect(candles).toHaveLength(10);
    expect(candles[0]).toMatchObject({
      open: expect.any(String),
      high: expect.any(String),
      low: expect.any(String),
      close: expect.any(String),
      volume: '1000',
    });
    // Prices must be string (decimal-safe)
    expect(typeof candles[0].open).toBe('string');
  });

  it('paper OHLCV evolves after exactly one explicit market heartbeat', async () => {
    await adapter.connect(dummyCreds);
    const before = await adapter.getOHLCV('EURUSD', 'H1', 30);
    await adapter.getCurrentPrice('EURUSD');
    const after = await adapter.getOHLCV('EURUSD', 'H1', 30);

    expect(after.at(-1)?.close).not.toBe(before.at(-1)?.close);
    expect(after.at(-1)?.timestamp.getTime()).toBe(
      (before.at(-1)?.timestamp.getTime() ?? 0) + 1_000,
    );
  });

  it('paper OHLCV honors timeframe spacing and exposes MTF friction fields', async () => {
    await adapter.connect(dummyCreds);
    const m1 = await adapter.getOHLCV('EURUSD', 'M1', 3);
    const h4 = await adapter.getOHLCV('EURUSD', 'H4', 3);

    expect(m1[1]!.timestamp.getTime() - m1[0]!.timestamp.getTime()).toBe(60_000);
    expect(h4[1]!.timestamp.getTime() - h4[0]!.timestamp.getTime()).toBe(4 * 60 * 60_000);
    expect(m1.at(-1)).toMatchObject({
      tickVolume: '1000',
      spreadPoints: '10',
      priceDigits: 5,
      brokerTime: expect.any(String),
    });
  });

  it('getAccountBalance returns simulated balance', async () => {
    await adapter.connect(dummyCreds);
    const balance = await adapter.getAccountBalance();
    expect(balance.currency).toBe('USD');
    expect(typeof balance.balance).toBe('string');
  });

  it('closeAllOrders returns zero closed (paper — no real positions)', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.closeAllOrders();
    expect(result.closedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it('getOpenPositions returns empty array (paper — no live positions)', async () => {
    await adapter.connect(dummyCreds);
    const positions = await adapter.getOpenPositions();
    expect(positions).toEqual([]);
  });

  it('getClosedTrades returns empty array', async () => {
    await adapter.connect(dummyCreds);
    const trades = await adapter.getClosedTrades(new Date(0), new Date());
    expect(trades).toEqual([]);
  });

  it('cannot be registered as live broker (liveTradingEnabled guard)', () => {
    // The PaperBrokerAdapter is PAPER_ONLY.
    // Its brokerId is 'paper-broker' — not 'metatrader5' or any live broker.
    // Verify it cannot masquerade as a live adapter.
    expect(adapter.brokerId).toBe('paper-broker');
    expect(adapter.brokerName).toContain('PAPER_ONLY');

    // setMode(LIVE) is silently ignored — mode stays DEMO
    adapter.setMode(BrokerMode.LIVE);
    expect(adapter.isConnected()).toBe(false); // Not connected before connect()
  });

  // ─── Sprint 51 PR-7 — fail-closed preconditions (Directive §AN #1) ────────

  it('throws NOT_CONNECTED (BrokerAdapterError) for data operations before connect()', async () => {
    const fresh = new PaperBrokerAdapter();
    await expect(fresh.getAccountInfo()).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
      name: 'BrokerAdapterError',
    });
    await expect(fresh.getOpenPositions()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(fresh.listOrders()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(fresh.getCurrentPrice('EURUSD')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(
      fresh.placeOrder({
        idempotencyKey: 'k-pre',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.01',
        stopLoss: '1.09000',
        takeProfit: '1.11000',
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('fails closed with NOT_CONNECTED for every data/order surface before connect', async () => {
    const fresh = new PaperBrokerAdapter();
    await expectAdapterError(() => fresh.getAccountInfo(), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.getAccountBalance(), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.getOpenPositions(), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.getPositionById('any'), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.getInstrumentList(), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.getCurrentPrice('EURUSD'), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.getOHLCV('EURUSD', 'H1', 5), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.placeOrder(order({})), 'NOT_CONNECTED');
    await expectAdapterError(
      () => fresh.modifyOrder('any', { newStopLoss: '1.09000' }),
      'NOT_CONNECTED',
    );
    await expectAdapterError(() => fresh.closeOrder('any'), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.cancelOrder('any'), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.listOrders(), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.getOrderById('any'), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.closeAllOrders(), 'NOT_CONNECTED');
    await expectAdapterError(() => fresh.getClosedTrades(new Date(0), new Date()), 'NOT_CONNECTED');
  });

  // ─── Deterministic price engine ───────────────────────────────────────────

  it('getCurrentPrice ticks the deterministic +2/−1 pip walk (spread + clock advance)', async () => {
    await adapter.connect(dummyCreds);
    const first = await adapter.getCurrentPrice('EURUSD');
    expect(first).toMatchObject({
      instrument: 'EURUSD',
      bid: '1.10020',
      ask: '1.10030',
      spread: '0.00010',
    });
    expect(first.timestamp.getTime()).toBe(DEFAULT_CLOCK_EPOCH + 1_000); // +1s per tick

    const second = await adapter.getCurrentPrice('EURUSD');
    expect(second).toMatchObject({ bid: '1.10010', ask: '1.10020', spread: '0.00010' });

    const third = await adapter.getCurrentPrice('EURUSD');
    expect(third).toMatchObject({ bid: '1.10030', ask: '1.10040', spread: '0.00010' });
  });

  it('account/position reads are pure snapshots — they never move the market', async () => {
    await adapter.connect(dummyCreds);
    await adapter.placeOrder(order({ idempotencyKey: 'snapshot-key' }));
    // No tick yet: valuation at the prevailing (base) quote.
    let info = await adapter.getAccountInfo();
    expect(info.equity).toBe('9999.50');
    // Account reads do not advance the walk:
    await adapter.getAccountInfo();
    await adapter.getOpenPositions();
    info = await adapter.getAccountInfo();
    expect(info.equity).toBe('9999.50');
    // One price poll = one tick: the revaluation follows the walk.
    await adapter.getCurrentPrice('EURUSD'); // bid → 1.10020
    info = await adapter.getAccountInfo();
    expect(info.equity).toBe('10001.50'); // (1.10020 − 1.10005) × 10000 = 1.50
  });

  it('getOHLCV candles are anchored to the simulated clock (deterministic)', async () => {
    await adapter.connect(dummyCreds);
    const candles = await adapter.getOHLCV('EURUSD', 'H1', 10);
    // Newest candle is anchored at the current simulated time.
    expect(candles[9]!.timestamp.getTime()).toBe(DEFAULT_CLOCK_EPOCH);
  });

  it('default feed + clock are the documented deterministic implementations', () => {
    const feed = new DeterministicPaperPriceFeed();
    expect(feed.quote()).toEqual({ bid: '1.10000', ask: '1.10010' }); // the classic quote
    expect(feed.tick()).toEqual({ bid: '1.10020', ask: '1.10030' }); // +2 pips
    expect(feed.tick()).toEqual({ bid: '1.10010', ask: '1.10020' }); // −1 pip
    expect(feed.tick()).toEqual({ bid: '1.10030', ask: '1.10040' });

    const clock = new DeterministicPaperClock();
    expect(clock.now().getTime()).toBe(DEFAULT_CLOCK_EPOCH);
    clock.advance(1000); // one market tick = one second of simulated time
    expect(clock.now().getTime()).toBe(DEFAULT_CLOCK_EPOCH + 1_000);
  });

  it('is fully deterministic — two fresh adapters replay identical order lifecycles', async () => {
    const a = new PaperBrokerAdapter();
    const b = new PaperBrokerAdapter();
    await a.connect({ accountId: 'paper-account-001' });
    await b.connect({ accountId: 'paper-account-001' });
    const request = order({ idempotencyKey: 'determinism-key' });

    const resultA = await a.placeOrder(request);
    const resultB = await b.placeOrder(request);
    expect(resultA).toEqual(resultB); // same id, same fill, same timestamps
    expect(resultA.filledPrice).toBe('1.10005');

    const priceA = await a.getCurrentPrice('EURUSD');
    const priceB = await b.getCurrentPrice('EURUSD');
    expect(priceA).toEqual(priceB);
    const positionsA = await a.getOpenPositions();
    const positionsB = await b.getOpenPositions();
    expect(positionsA).toEqual(positionsB);
  });

  // ─── MARKET orders: mid fills, positions, balance/margin realism ──────────

  it('placeOrder MARKET BUY fills at the quote mid and creates a position', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder(order({ idempotencyKey: 'market-buy-1' }));
    expect(result.success).toBe(true);
    expect(result.status).toBe('FILLED');
    expect(result.brokerMessage).toContain('PAPER_ONLY');
    expect(result.externalOrderId).toBe('paper-order-000001');
    expect(result.filledPrice).toBe('1.10005');
    expect(result.filledQuantity).toBe('0.10');
    expect(result.filledAt).toEqual(new Date(DEFAULT_CLOCK_EPOCH));

    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      externalOrderId: 'paper-order-000001',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.10',
      openPrice: '1.10005',
      currentPrice: '1.10000', // exit-side quote (bid for BUY)
      stopLoss: '0',
      takeProfit: '0',
      unrealisedPnl: '-0.50', // (bid − mid) × 10000, exact
      commission: '0',
      swap: '0',
    });
  });

  it('placeOrder MARKET SELL fills at the quote mid (exit side is the ask)', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder(
      order({ idempotencyKey: 'market-sell-1', direction: 'SELL' }),
    );
    expect(result.filledPrice).toBe('1.10005');
    const positions = await adapter.getOpenPositions();
    expect(positions[0]).toMatchObject({
      direction: 'SELL',
      openPrice: '1.10005',
      currentPrice: '1.10010', // exit-side quote (ask for SELL)
      unrealisedPnl: '-0.50',
    });
  });

  it('placing orders does not tick the market (fills use the prevailing quote)', async () => {
    await adapter.connect(dummyCreds);
    await adapter.placeOrder(order({ idempotencyKey: 'no-tick-a' }));
    const second = await adapter.placeOrder(order({ idempotencyKey: 'no-tick-b' }));
    expect(second.filledPrice).toBe('1.10005'); // same prevailing quote
  });

  it('keeps legacy MARKET-only requests valid (orderKind omitted defaults to MARKET)', async () => {
    await adapter.connect(dummyCreds);
    const legacy = { ...order({ idempotencyKey: 'legacy-market' }) } as Partial<BrokerOrderRequest>;
    delete legacy.orderKind;
    const result = await adapter.placeOrder(legacy as BrokerOrderRequest);
    expect(result.status).toBe('FILLED');
    expect(result.filledPrice).toBe('1.10005');
  });

  it('rejects unknown order kinds loudly (fail-closed, never a silent downgrade)', async () => {
    await adapter.connect(dummyCreds);
    await expectAdapterError(
      () =>
        adapter.placeOrder(
          order({
            idempotencyKey: 'bad-kind',
            // Deliberately invalid at runtime (typed callers cannot produce it).
            orderKind: 'PEGGED' as BrokerOrderRequest['orderKind'],
          }),
        ),
      'INVALID_ORDER_TYPE',
    );
    // No order was created by the rejected request:
    expect(await adapter.listOrders()).toEqual([]);
    expect(await adapter.getOpenPositions()).toEqual([]);
  });

  it('account snapshot reflects balance/equity/margin/freeMargin/marginLevel exactly', async () => {
    await adapter.connect(dummyCreds);
    const fresh = await adapter.getAccountInfo();
    expect(fresh).toEqual({
      accountId: 'paper-account-001',
      currency: 'USD',
      leverage: 100,
      balance: '10000.00',
      equity: '10000.00',
      margin: '0.00',
      freeMargin: '10000.00',
      marginLevel: '0.00',
    });

    await adapter.placeOrder(order({ idempotencyKey: 'accounting-1' }));
    const after = await adapter.getAccountInfo();
    expect(after).toEqual({
      accountId: 'paper-account-001',
      currency: 'USD',
      leverage: 100,
      balance: '10000.00', // realized P&L only — unrealized does not touch balance
      equity: '9999.50', // balance + rounded unrealized
      margin: '110.01', // 10000 units × 1.10005 / 100, half-up at 2dp
      freeMargin: '9889.49',
      marginLevel: '9089.63', // equity / margin × 100
    });
  });

  it('getAccountBalance returns the exact snapshot with the simulated timestamp', async () => {
    await adapter.connect(dummyCreds);
    const balance = await adapter.getAccountBalance();
    expect(balance).toMatchObject({ balance: '10000.00', equity: '10000.00', currency: 'USD' });
    expect(balance.timestamp.getTime()).toBe(DEFAULT_CLOCK_EPOCH);
  });

  it('getRequiredMargin keeps the Sprint 32 formula (lot × contractSize × mid / leverage)', async () => {
    await adapter.connect(dummyCreds);
    await expect(
      adapter.getRequiredMargin({ instrument: 'EURUSD', lotSize: '0.10', direction: 'BUY' }),
    ).resolves.toBe(
      '110.01', // 0.10 × 100000 × 1.10005 / 100 — exact, half-up at 2dp
    );
    await expect(
      adapter.getRequiredMargin({ instrument: 'EURUSD', lotSize: '0.10', direction: 'SELL' }),
    ).resolves.toBe('110.01');
    // 4-decimal lot spellings are exact multiples of the lot step by VALUE:
    await expect(
      adapter.getRequiredMargin({ instrument: 'EURUSD', lotSize: '0.5000', direction: 'BUY' }),
    ).resolves.toBe('550.03'); // 0.5 × 100000 × 1.10005 / 100 = 550.025 → 550.03
    // Fail-closed nulls: unknown instrument / invalid lot.
    await expect(
      adapter.getRequiredMargin({ instrument: 'GBPUSD', lotSize: '0.10', direction: 'BUY' }),
    ).resolves.toBeNull();
    await expect(
      adapter.getRequiredMargin({ instrument: 'EURUSD', lotSize: 'abc', direction: 'BUY' }),
    ).resolves.toBeNull();
  });

  it('getInstrumentList returns the EURUSD paper metadata', async () => {
    await adapter.connect(dummyCreds);
    const instruments = await adapter.getInstrumentList();
    expect(instruments).toEqual([
      {
        symbol: 'EURUSD',
        description: 'Euro vs US Dollar (Paper)',
        digits: 5,
        minLot: '0.01',
        maxLot: '100.00',
        lotStep: '0.01',
        contractSize: '100000',
      },
    ]);
  });

  it('MARKET orders fail closed with INSUFFICIENT_MARGIN when free margin cannot cover them', async () => {
    await adapter.connect(dummyCreds);
    const err = await expectAdapterError(
      () => adapter.placeOrder(order({ idempotencyKey: 'too-big', lotSize: '100.00' })),
      'INSUFFICIENT_MARGIN',
    );
    expect(err.message).toContain('110005.00'); // required margin in the message
    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(0);
  });

  it('rejects invalid instruments (single-instrument simulation)', async () => {
    await adapter.connect(dummyCreds);
    await expectAdapterError(
      () => adapter.placeOrder(order({ idempotencyKey: 'bad-instrument', instrument: 'GBPUSD' })),
      'INVALID_INSTRUMENT',
    );
    await expectAdapterError(() => adapter.getCurrentPrice('GBPUSD'), 'INVALID_INSTRUMENT');
    await expectAdapterError(() => adapter.getOHLCV('GBPUSD', 'H1', 5), 'INVALID_INSTRUMENT');
  });

  it('rejects invalid lot sizes (min/max/step/positivity rules)', async () => {
    await adapter.connect(dummyCreds);
    for (const lotSize of ['0', '-0.10', 'abc', '0.001', '0.105', '150.00', '']) {
      await expectAdapterError(
        () =>
          adapter.placeOrder(order({ idempotencyKey: `bad-lot-${lotSize || 'empty'}`, lotSize })),
        'INVALID_LOT_SIZE',
      );
    }
    expect(await adapter.getOpenPositions()).toHaveLength(0);
  });

  it('accepts lot spellings that are exact step multiples by value (e.g. 0.5000)', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder(
      order({ idempotencyKey: 'spelled-lot', lotSize: '0.5000' }),
    );
    expect(result.status).toBe('FILLED');
    expect(result.filledQuantity).toBe('0.5000');
    const positions = await adapter.getOpenPositions();
    expect(positions[0]).toMatchObject({ lotSize: '0.5000' }); // caller spelling preserved
  });

  it('rejects non-decimal / negative protection levels', async () => {
    await adapter.connect(dummyCreds);
    await expectAdapterError(
      () => adapter.placeOrder(order({ idempotencyKey: 'bad-sl', stopLoss: 'abc' })),
      'INVALID_PRICE',
    );
    await expectAdapterError(
      () => adapter.placeOrder(order({ idempotencyKey: 'bad-tp', takeProfit: '-1.11000' })),
      'INVALID_PRICE',
    );
  });

  // ─── Idempotency (clientOrderId / idempotencyKey dedup surface) ───────────

  it('replays the ORIGINAL result for a repeat idempotencyKey (true dedupe, no double fill)', async () => {
    await adapter.connect(dummyCreds);
    const first = await adapter.placeOrder(order({ idempotencyKey: 'idem-key-1' }));
    const replay = await adapter.placeOrder(order({ idempotencyKey: 'idem-key-1' }));
    expect(replay).toEqual(first); // original acknowledgement, verbatim
    expect(replay.externalOrderId).toBe('paper-order-000001');
    expect(await adapter.getOpenPositions()).toHaveLength(1); // no double fill
    // Different key → a genuinely new order:
    const second = await adapter.placeOrder(order({ idempotencyKey: 'idem-key-2' }));
    expect(second.externalOrderId).toBe('paper-order-000002');
    expect(await adapter.getOpenPositions()).toHaveLength(2);
  });

  it('dedupes on the caller-supplied clientOrderId (the provider-side dedup surface)', async () => {
    await adapter.connect(dummyCreds);
    const first = await adapter.placeOrder(
      order({ idempotencyKey: 'idem-a', clientOrderId: 'paper-client-dedupe' }),
    );
    // Same clientOrderId, DIFFERENT idempotencyKey → still the original result:
    const replay = await adapter.placeOrder(
      order({ idempotencyKey: 'idem-b', clientOrderId: 'paper-client-dedupe' }),
    );
    expect(replay).toEqual(first);
    expect(await adapter.getOpenPositions()).toHaveLength(1);
  });

  it('replays the original PENDING result for a repeat working-order placement', async () => {
    await adapter.connect(dummyCreds);
    const first = await adapter.placeOrder(
      order({
        idempotencyKey: 'idem-work',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    expect(first.status).toBe('PENDING');
    const replay = await adapter.placeOrder(
      order({
        idempotencyKey: 'idem-work',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    expect(replay).toEqual(first);
    expect(await adapter.listOrders()).toHaveLength(1);
  });

  // ─── Working orders (LIMIT / STOP / STOP_LIMIT) ───────────────────────────

  it('LIMIT orders place WORKING entries (PENDING result, BrokerOrderState surface)', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder(
      order({
        idempotencyKey: 'limit-1',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
        timeInForce: 'GTC',
      }),
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe('PENDING');
    expect(result.filledPrice).toBeUndefined();
    expect(result.brokerMessage).toContain('PAPER_ONLY');

    const openOrders = await adapter.listOrders();
    expect(openOrders).toHaveLength(1);
    expect(openOrders[0]).toMatchObject({
      providerOrderId: 'paper-order-000001',
      status: 'WORKING',
      instrument: 'EURUSD',
      direction: 'BUY',
      requestedQuantity: '0.10',
      filledQuantity: '0.0000',
      avgFillPrice: null,
      orderKind: 'LIMIT',
      limitPrice: '1.09500',
      stopPrice: null,
      timeInForce: 'GTC',
    });
    expect(openOrders[0]!.placedAt!.getTime()).toBe(DEFAULT_CLOCK_EPOCH);
    // getOrderById agrees (the interface's history-capable lookup):
    expect((await adapter.getOrderById('paper-order-000001'))?.status).toBe('WORKING');
  });

  it('BUY LIMIT fills at the prevailing ask when the market falls to the limit', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.09400', ask: '1.09410' }]);
    const placed = await sim.placeOrder(
      order({
        idempotencyKey: 'buy-limit',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    expect(placed.status).toBe('PENDING');

    await sim.getCurrentPrice('EURUSD'); // tick → ask 1.09410 ≤ 1.09500
    expect(await sim.listOrders()).toHaveLength(0);

    const positions = await sim.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.openPrice).toBe('1.09410'); // fill at the quote — never worse than the limit
    // The order's terminal state is FILLED with the fill price:
    expect(await sim.getOrderById('paper-order-000001')).toMatchObject({
      status: 'FILLED',
      filledQuantity: '0.10',
      avgFillPrice: '1.09410',
    });
    expect(await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000))).toHaveLength(
      0,
    );
  });

  it('SELL LIMIT fills at the prevailing bid when the market rises to the limit', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.10050', ask: '1.10060' }]);
    await sim.placeOrder(
      order({
        idempotencyKey: 'sell-limit',
        direction: 'SELL',
        orderKind: 'LIMIT',
        limitPrice: '1.10050',
      }),
    );
    await sim.getCurrentPrice('EURUSD'); // tick → bid 1.10050 ≥ limit
    const positions = await sim.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ direction: 'SELL', openPrice: '1.10050' });
  });

  it('BUY STOP triggers on the default upward walk and fills at the ask', async () => {
    await adapter.connect(dummyCreds);
    const result = await adapter.placeOrder(
      order({ idempotencyKey: 'buy-stop', orderKind: 'STOP', stopPrice: '1.10030' }),
    );
    expect(result.status).toBe('PENDING');

    await adapter.getCurrentPrice('EURUSD'); // default tick 1: ask 1.10030 ≥ stop
    const positions = await adapter.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.openPrice).toBe('1.10030'); // prevailing ask
    expect(await adapter.listOrders()).toHaveLength(0);
  });

  it('SELL STOP fills at the bid when the market falls to the stop', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.09900', ask: '1.09910' }]);
    await sim.placeOrder(
      order({
        idempotencyKey: 'sell-stop',
        direction: 'SELL',
        orderKind: 'STOP',
        stopPrice: '1.09900',
      }),
    );
    await sim.getCurrentPrice('EURUSD'); // tick → bid 1.09900 ≤ stop
    const positions = await sim.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.openPrice).toBe('1.09900');
  });

  it('STOP_LIMIT triggers like STOP then fills like LIMIT in the same tick', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.10500', ask: '1.10510' }]);
    const placed = await sim.placeOrder(
      order({
        idempotencyKey: 'stop-limit-ok',
        orderKind: 'STOP_LIMIT',
        stopPrice: '1.10500',
        limitPrice: '1.10550',
      }),
    );
    expect(placed.status).toBe('PENDING');

    await sim.getCurrentPrice('EURUSD'); // trigger (ask ≥ 1.10500) and fill (ask ≤ 1.10550)
    const positions = await sim.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.openPrice).toBe('1.10510');
    expect(await sim.listOrders()).toHaveLength(0);
  });

  it('STOP_LIMIT stays WORKING (honest miss) when the price runs past the limit', async () => {
    const sim = scriptedAdapter([
      BASE,
      { bid: '1.10500', ask: '1.10530' }, // triggers the stop but ask > limit 1.10520
      { bid: '1.10500', ask: '1.10510' }, // comes back to the limit → fills
    ]);
    await sim.placeOrder(
      order({
        idempotencyKey: 'stop-limit-miss',
        orderKind: 'STOP_LIMIT',
        stopPrice: '1.10500',
        limitPrice: '1.10520',
      }),
    );

    await sim.getCurrentPrice('EURUSD');
    expect(await sim.getOpenPositions()).toHaveLength(0); // no premature fill
    const stillWorking = await sim.listOrders();
    expect(stillWorking).toHaveLength(1);
    expect(stillWorking[0]).toMatchObject({
      status: 'WORKING',
      orderKind: 'STOP_LIMIT',
    });

    await sim.getCurrentPrice('EURUSD'); // price returns to the limit
    const positions = await sim.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.openPrice).toBe('1.10510');
    expect(await sim.listOrders()).toHaveLength(0);
  });

  it('working-order fills inherit the order protection levels', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.09400', ask: '1.09410' }]);
    await sim.placeOrder(
      order({
        idempotencyKey: 'limit-protected',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
        stopLoss: '1.09000',
        takeProfit: '1.12000',
      }),
    );
    await sim.getCurrentPrice('EURUSD');
    const positions = await sim.getOpenPositions();
    expect(positions[0]).toMatchObject({ stopLoss: '1.09000', takeProfit: '1.12000' });
  });

  it('working-order fills REJECT honestly when free margin cannot cover them at fill time', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.09400', ask: '1.09410' }]);
    await sim.placeOrder(
      order({
        idempotencyKey: 'limit-too-big',
        lotSize: '100.00',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    await sim.getCurrentPrice('EURUSD'); // fill attempt: 10,000,000 units ≈ 109,410 USD margin
    expect(await sim.getOpenPositions()).toHaveLength(0);
    expect(await sim.listOrders()).toHaveLength(0); // terminal REJECTED state — left the working set
    expect(await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000))).toHaveLength(
      0,
    );
    // The order's terminal state is honestly REJECTED:
    expect(await sim.getOrderById('paper-order-000001')).toMatchObject({
      status: 'REJECTED',
      filledQuantity: '0.0000',
    });
    const info = await sim.getAccountInfo();
    expect(info.balance).toBe('10000.00'); // untouched
  });

  it('validation fails closed BEFORE order creation for missing order-kind parameters', async () => {
    await adapter.connect(dummyCreds);
    await expectAdapterError(
      () => adapter.placeOrder(order({ idempotencyKey: 'limit-no-price', orderKind: 'LIMIT' })),
      'INVALID_PRICE',
    );
    await expectAdapterError(
      () => adapter.placeOrder(order({ idempotencyKey: 'stop-no-price', orderKind: 'STOP' })),
      'INVALID_PRICE',
    );
    await expectAdapterError(
      () =>
        adapter.placeOrder(
          order({
            idempotencyKey: 'stop-limit-missing',
            orderKind: 'STOP_LIMIT',
            stopPrice: '1.10500',
          }),
        ),
      'INVALID_PRICE',
    );
    // No order was created by any of the rejected requests:
    expect(await adapter.listOrders()).toHaveLength(0);
    expect(await adapter.getOpenPositions()).toHaveLength(0);
  });

  it('rejects zero/negative limit and stop prices', async () => {
    await adapter.connect(dummyCreds);
    await expectAdapterError(
      () =>
        adapter.placeOrder(
          order({ idempotencyKey: 'zero-limit', orderKind: 'LIMIT', limitPrice: '0' }),
        ),
      'INVALID_PRICE',
    );
    await expectAdapterError(
      () =>
        adapter.placeOrder(
          order({ idempotencyKey: 'neg-stop', orderKind: 'STOP', stopPrice: '-1.10000' }),
        ),
      'INVALID_PRICE',
    );
  });

  // ─── SL / TP evaluation on ticks ──────────────────────────────────────────

  it('BUY position TP closes exactly at the level (closeReason TP, balance adjusted)', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.10500', ask: '1.10510' }]);
    await sim.placeOrder(order({ idempotencyKey: 'tp-buy', takeProfit: '1.10500' }));
    await sim.getCurrentPrice('EURUSD'); // bid 1.10500 ≥ TP

    expect(await sim.getOpenPositions()).toHaveLength(0);
    const trades = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      externalOrderId: 'paper-order-000001',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.10',
      openPrice: '1.10005',
      closePrice: '1.10500',
      realisedPnl: '49.50', // (1.10500 − 1.10005) × 10000
      commission: '0',
      swap: '0',
      closeReason: 'TP',
    });
    const info = await sim.getAccountInfo();
    expect(info.balance).toBe('10049.50'); // realized P&L adjusted the balance
    expect(info.margin).toBe('0.00');
  });

  it('BUY position SL closes exactly at the level (closeReason SL)', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.09500', ask: '1.09510' }]);
    await sim.placeOrder(order({ idempotencyKey: 'sl-buy', stopLoss: '1.09500' }));
    await sim.getCurrentPrice('EURUSD'); // bid 1.09500 ≤ SL

    const trades = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      closePrice: '1.09500',
      realisedPnl: '-50.50', // (1.09500 − 1.10005) × 10000
      closeReason: 'SL',
    });
    const info = await sim.getAccountInfo();
    expect(info.balance).toBe('9949.50');
  });

  it('SELL position TP closes when ask drops to the level', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.09490', ask: '1.09500' }]);
    await sim.placeOrder(
      order({ idempotencyKey: 'tp-sell', direction: 'SELL', takeProfit: '1.09500' }),
    );
    await sim.getCurrentPrice('EURUSD'); // ask 1.09500 ≤ TP

    const trades = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      direction: 'SELL',
      openPrice: '1.10005',
      closePrice: '1.09500',
      realisedPnl: '50.50', // (1.10005 − 1.09500) × 10000
      closeReason: 'TP',
    });
  });

  it('SELL position SL closes when ask rises to the level', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.10490', ask: '1.10500' }]);
    await sim.placeOrder(
      order({ idempotencyKey: 'sl-sell', direction: 'SELL', stopLoss: '1.10500' }),
    );
    await sim.getCurrentPrice('EURUSD'); // ask 1.10500 ≥ SL

    const trades = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      closePrice: '1.10500',
      realisedPnl: '-49.50', // (1.10005 − 1.10500) × 10000
      closeReason: 'SL',
    });
  });

  it('positions created by a fill this tick are first evaluated on the NEXT tick', async () => {
    const sim = scriptedAdapter([
      BASE,
      { bid: '1.09400', ask: '1.09410' }, // fills the BUY LIMIT; its bid ALREADY satisfies the SL condition
      { bid: '1.09390', ask: '1.09400' }, // next tick: SL evaluates and closes
    ]);
    await sim.placeOrder(
      order({
        idempotencyKey: 'next-tick',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
        stopLoss: '1.09400', // bid 1.09400 ≤ 1.09400 would close — but not on the fill tick
      }),
    );
    await sim.getCurrentPrice('EURUSD'); // fill at ask 1.09410; SL NOT evaluated on the fill tick
    expect(await sim.getOpenPositions()).toHaveLength(1);

    await sim.getCurrentPrice('EURUSD'); // next tick: bid 1.09390 ≤ SL → closes
    expect(await sim.getOpenPositions()).toHaveLength(0);
    const trades = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ closePrice: '1.09400', closeReason: 'SL' });
  });

  // ─── modifyOrder ──────────────────────────────────────────────────────────

  it('modifyOrder updates a position SL/TP (and clears with "0")', async () => {
    await adapter.connect(dummyCreds);
    await adapter.placeOrder(
      order({ idempotencyKey: 'modify-1', stopLoss: '1.09000', takeProfit: '1.11000' }),
    );
    const result = await adapter.modifyOrder('paper-order-000001', {
      newStopLoss: '1.09200',
      newTakeProfit: '1.10800',
    });
    expect(result).toMatchObject({
      success: true,
      externalOrderId: 'paper-order-000001',
      status: 'FILLED',
    });

    const positions = await adapter.getOpenPositions();
    expect(positions[0]).toMatchObject({ stopLoss: '1.09200', takeProfit: '1.10800' });

    await adapter.modifyOrder('paper-order-000001', { newTakeProfit: '0' }); // clear
    const cleared = await adapter.getOpenPositions();
    expect(cleared[0]!.takeProfit).toBe('0');
  });

  it('modifyOrder updates a WORKING order protection (carried into the eventual fill)', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.09400', ask: '1.09410' }]);
    await sim.placeOrder(
      order({
        idempotencyKey: 'modify-working',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    await sim.modifyOrder('paper-order-000001', {
      newStopLoss: '1.09100',
      newTakeProfit: '1.11500',
    });
    await sim.getCurrentPrice('EURUSD'); // fill
    const positions = await sim.getOpenPositions();
    expect(positions[0]).toMatchObject({ stopLoss: '1.09100', takeProfit: '1.11500' });
  });

  it('modifyOrder fails closed on empty modifications, trailing stops and unknown ids', async () => {
    await adapter.connect(dummyCreds);
    await expectAdapterError(
      () => adapter.modifyOrder('paper-order-000001', {}),
      'INVALID_REQUEST',
    );
    await expectAdapterError(
      () => adapter.modifyOrder('paper-order-000001', { newTrailingStop: '0.00100' }),
      'INVALID_REQUEST', // honest: trailing stops are not simulated (OANDA-sibling convention)
    );
    await expectAdapterError(
      () => adapter.modifyOrder('paper-order-999999', { newStopLoss: '1.09000' }),
      'POSITION_NOT_FOUND',
    );
    await expectAdapterError(
      () => adapter.modifyOrder('paper-order-000001', { newStopLoss: 'abc' }),
      'INVALID_PRICE',
    );
  });

  // ─── closeOrder (full / partial) ──────────────────────────────────────────

  it('closeOrder closes a BUY fully at the mid (closeReason MANUAL, flat P&L)', async () => {
    await adapter.connect(dummyCreds);
    await adapter.placeOrder(order({ idempotencyKey: 'close-full' }));
    const result = await adapter.closeOrder('paper-order-000001');
    expect(result).toMatchObject({
      success: true,
      externalOrderId: 'paper-order-000001',
      status: 'FILLED',
      filledPrice: '1.10005',
      filledQuantity: '0.10',
      brokerMessage: 'PAPER_ONLY simulated close',
    });

    expect(await adapter.getOpenPositions()).toHaveLength(0);
    const trades = await adapter.getClosedTrades(new Date(0), new Date());
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      openPrice: '1.10005',
      closePrice: '1.10005',
      lotSize: '0.10',
      realisedPnl: '0.00', // mid open, mid close, no intervening tick — flat
      closeReason: 'MANUAL',
    });
    expect((await adapter.getAccountInfo()).balance).toBe('10000.00');
  });

  it('closeOrder partial close respects lotSize, books the reduced part, reduces margin', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.10200', ask: '1.10210' }]);
    await sim.placeOrder(order({ idempotencyKey: 'close-partial' }));
    await sim.getCurrentPrice('EURUSD'); // revalue at bid 1.10200
    const result = await sim.closeOrder('paper-order-000001', '0.04');
    expect(result.filledPrice).toBe('1.10205'); // the mid of the prevailing quote

    const positions = await sim.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      lotSize: '0.06',
      openPrice: '1.10005',
      currentPrice: '1.10200',
      unrealisedPnl: '11.70', // (1.10200 − 1.10005) × 6000
    });

    const trades = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000));
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      lotSize: '0.04',
      closePrice: '1.10205',
      realisedPnl: '8.00', // (1.10205 − 1.10005) × 4000
      closeReason: 'MANUAL',
    });

    const info = await sim.getAccountInfo();
    expect(info.balance).toBe('10008.00');
    expect(info.margin).toBe('66.00'); // 6000 units × 1.10005 / 100 = 66.003 → 66.00

    // Closing the remainder closes the position fully:
    await sim.closeOrder('paper-order-000001', '0.06');
    expect(await sim.getOpenPositions()).toHaveLength(0);
    const allTrades = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000));
    expect(allTrades).toHaveLength(2);
    expect(allTrades[1]).toMatchObject({ lotSize: '0.06', realisedPnl: '12.00' });
  });

  it('closeOrder fails closed for excess/invalid partial sizes and unknown/working ids', async () => {
    await adapter.connect(dummyCreds);
    await adapter.placeOrder(order({ idempotencyKey: 'close-guard' }));
    await expectAdapterError(
      () => adapter.closeOrder('paper-order-000001', '0.50'),
      'INVALID_LOT_SIZE',
    );
    await expectAdapterError(
      () => adapter.closeOrder('paper-order-000001', '0'),
      'INVALID_LOT_SIZE',
    );
    // Unknown id → honest failed result (never a silent success, never a throw):
    const unknown = await adapter.closeOrder('paper-order-999999');
    expect(unknown).toMatchObject({ success: false, status: 'REJECTED' });

    // A WORKING order id is not a position — cancelOrder is that path:
    await adapter.placeOrder(
      order({
        idempotencyKey: 'close-working',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    const workingClose = await adapter.closeOrder('paper-order-000002');
    expect(workingClose).toMatchObject({ success: false, status: 'REJECTED' });
    expect(workingClose.brokerMessage).toContain('cancelOrder');
  });

  it('getPositionById maps open positions and returns null for unknown/closed ids', async () => {
    await adapter.connect(dummyCreds);
    expect(await adapter.getPositionById('paper-order-000001')).toBeNull();
    await adapter.placeOrder(order({ idempotencyKey: 'by-id' }));
    const position = await adapter.getPositionById('paper-order-000001');
    expect(position).toMatchObject({
      externalOrderId: 'paper-order-000001',
      openPrice: '1.10005',
      currentPrice: '1.10000',
      unrealisedPnl: '-0.50',
    });
    await adapter.closeOrder('paper-order-000001');
    expect(await adapter.getPositionById('paper-order-000001')).toBeNull();
  });

  // ─── cancelOrder (concrete method — outside IBrokerAdapter) ───────────────

  it('cancelOrder cancels a WORKING order and removes it from the order list', async () => {
    await adapter.connect(dummyCreds);
    await adapter.placeOrder(
      order({
        idempotencyKey: 'cancel-1',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    const result = await adapter.cancelOrder('paper-order-000001');
    expect(result).toMatchObject({
      success: true,
      externalOrderId: 'paper-order-000001',
      status: 'FILLED',
      brokerMessage: 'PAPER_ONLY working order cancelled',
    });
    expect(await adapter.listOrders()).toHaveLength(0);
    expect(await adapter.getOpenPositions()).toHaveLength(0); // never filled
    // The order's terminal state is CANCELLED (history-capable lookup):
    expect(await adapter.getOrderById('paper-order-000001')).toMatchObject({
      status: 'CANCELLED',
      filledQuantity: '0.0000',
    });
  });

  it('cancelOrder fails closed for unknown ids, filled orders and double cancels', async () => {
    await adapter.connect(dummyCreds);
    await expectAdapterError(() => adapter.cancelOrder('paper-order-999999'), 'POSITION_NOT_FOUND');
    // Filled orders are positions, not working orders:
    await adapter.placeOrder(order({ idempotencyKey: 'cancel-filled' }));
    const err = await expectAdapterError(
      () => adapter.cancelOrder('paper-order-000001'),
      'POSITION_NOT_FOUND',
    );
    // Documented honest choice: no ORDER_NOT_FOUND code exists in the set.
    expect(err.message).toContain('not a working paper order');
  });

  // ─── closeAllOrders ───────────────────────────────────────────────────────

  it('closeAllOrders closes positions only (SYSTEM) and leaves working orders untouched', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.10200', ask: '1.10210' }]);
    await sim.placeOrder(order({ idempotencyKey: 'kill-buy' }));
    await sim.placeOrder(order({ idempotencyKey: 'kill-sell', direction: 'SELL' }));
    await sim.placeOrder(
      order({
        idempotencyKey: 'kill-limit',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    await sim.getCurrentPrice('EURUSD'); // revalue at bid 1.10200 / ask 1.10210

    const result = await sim.closeAllOrders();
    expect(result).toEqual({ closedCount: 2, failedCount: 0, errors: [] });
    expect(await sim.getOpenPositions()).toHaveLength(0);
    // Documented decision: the kill switch closes open EXPOSURE — working
    // orders stay (cancelOrder is their path).
    expect(await sim.listOrders()).toHaveLength(1);

    const trades = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 60_000));
    expect(trades).toHaveLength(2);
    expect(trades.map((t) => t.closeReason)).toEqual(['SYSTEM', 'SYSTEM']);
    // Symmetric book: BUY +20.00, SELL −20.00 (both closed at the mid 1.10205):
    expect(trades.map((t) => t.realisedPnl)).toEqual(['20.00', '-20.00']);
    expect((await sim.getAccountInfo()).balance).toBe('10000.00'); // net flat
  });

  // ─── Closed-trade history ─────────────────────────────────────────────────

  it('getClosedTrades filters by the [from, to] window (inclusive, deterministic clock)', async () => {
    const sim = scriptedAdapter([BASE, { bid: '1.10500', ask: '1.10510' }]);
    await sim.placeOrder(order({ idempotencyKey: 'window-tp', takeProfit: '1.10500' }));
    await sim.getCurrentPrice('EURUSD'); // closed at CLOCK_BASE_MS + 1000

    const included = await sim.getClosedTrades(
      new Date(CLOCK_BASE_MS),
      new Date(CLOCK_BASE_MS + 1000),
    );
    expect(included).toHaveLength(1);
    expect(included[0]!.closedAt.getTime()).toBe(CLOCK_BASE_MS + 1000);
    expect(included[0]!.openedAt.getTime()).toBe(CLOCK_BASE_MS);

    const before = await sim.getClosedTrades(
      new Date(CLOCK_BASE_MS + 1001),
      new Date(CLOCK_BASE_MS + 5000),
    );
    expect(before).toEqual([]);
    const after = await sim.getClosedTrades(new Date(0), new Date(CLOCK_BASE_MS + 999));
    expect(after).toEqual([]);
  });

  // ─── One order = one position; state persists across reconnects ───────────

  it('two orders create two independent positions (no netting)', async () => {
    await adapter.connect(dummyCreds);
    await adapter.placeOrder(order({ idempotencyKey: 'multi-a' }));
    await adapter.placeOrder(order({ idempotencyKey: 'multi-b', direction: 'SELL' }));
    const positions = await adapter.getOpenPositions();
    expect(positions.map((p) => p.externalOrderId)).toEqual([
      'paper-order-000001',
      'paper-order-000002',
    ]);
    expect(positions.map((p) => p.direction)).toEqual(['BUY', 'SELL']);
  });

  it('account state persists across disconnect/reconnect (health checks never wipe it)', async () => {
    await adapter.connect(dummyCreds);
    await adapter.placeOrder(order({ idempotencyKey: 'persist-1' }));
    await adapter.placeOrder(
      order({
        idempotencyKey: 'persist-2',
        orderKind: 'LIMIT',
        limitPrice: '1.09500',
      }),
    );
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
    await adapter.connect({ accountId: 'paper-account-001' });

    expect(await adapter.getOpenPositions()).toHaveLength(1);
    expect(await adapter.listOrders()).toHaveLength(1);
    const info = await adapter.getAccountInfo();
    expect(info.balance).toBe('10000.00');
    expect(info.equity).toBe('9999.50');
  });
});
