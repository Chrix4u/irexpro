import { ConfigService } from '@nestjs/config';
import { DerivPublicFxStreamService } from './deriv-public-fx-stream.service';
import { LivePaperMarketDataService } from './live-paper-market-data.service';

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readyState = 1;
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const configWith = (overrides: Record<string, unknown> = {}) =>
  ({
    get: jest.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        'vpsForexScanner.enabled': true,
        'vpsForexScanner.fastMarkStreamEnabled': true,
        'vpsForexScanner.fastMarkProvider': 'DERIV',
        'vpsForexScanner.brokerConnectionId': 'paper-1',
        ...overrides,
      };
      return key in values ? values[key] : fallback;
    }),
  }) as unknown as ConfigService;

const marketMock = () =>
  ({
    updateStreamingMidQuote: jest.fn(),
    updateClosedM1Candles: jest.fn(),
    hasContiguousM1History: jest.fn().mockReturnValue(true),
  }) as unknown as LivePaperMarketDataService;

describe('DerivPublicFxStreamService', () => {
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T12:00:30.000Z'));
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    const target = globalThis as unknown as { WebSocket?: unknown };
    if (originalWebSocket === undefined) delete target.WebSocket;
    else target.WebSocket = originalWebSocket;
    FakeWebSocket.last = null;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('subscribes to all six FX pairs and requests M1 bootstrap history on connect', () => {
    const market = marketMock();
    const service = new DerivPublicFxStreamService(configWith(), market);

    (service as unknown as { connect(): void }).connect();
    const socket = FakeWebSocket.last!;
    expect(socket.url).toBe('wss://api.derivws.com/trading/v1/options/ws/public');

    socket.emit('open');
    const sent = socket.sent.map((payload) => JSON.parse(payload));
    expect(sent[0]).toEqual({
      ticks: ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'frxUSDCHF'],
      subscribe: 1,
      req_id: 1,
    });
    expect(sent.slice(1)).toHaveLength(6);
    expect(sent.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticks_history: 'frxEURUSD',
          count: 500,
          end: 'latest',
          style: 'candles',
          granularity: 60,
        }),
        expect.objectContaining({ ticks_history: 'frxUSDJPY' }),
        expect.objectContaining({ ticks_history: 'frxUSDCHF' }),
      ]),
    );

    service.onModuleDestroy();
    expect(socket.closed).toBe(true);
  });

  it('keeps the latest 500 completed Deriv M1 bootstrap candles for read-only chart aggregation', async () => {
    const market = marketMock();
    const service = new DerivPublicFxStreamService(configWith(), market);
    const currentMinuteStart = Math.floor(Date.now() / 60_000) * 60_000;
    const firstOpen = currentMinuteStart - 501 * 60_000;
    const candles = Array.from({ length: 502 }, (_, index) => ({
      epoch: (firstOpen + index * 60_000) / 1000,
      open: 1.1 + index / 100000,
      high: 1.1002 + index / 100000,
      low: 1.0998 + index / 100000,
      close: 1.1001 + index / 100000,
    }));

    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({
        msg_type: 'candles',
        candles,
        echo_req: { ticks_history: 'frxEURUSD' },
      }),
    );

    const rows = (market.updateClosedM1Candles as jest.Mock).mock.calls[0]![1];
    expect(rows).toHaveLength(500);
    service.onModuleDestroy();
  });

  it('routes a Deriv tick into the PAPER mid-quote stream with the exact paper binding', async () => {
    const market = marketMock();
    const service = new DerivPublicFxStreamService(configWith(), market);

    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({
        msg_type: 'tick',
        tick: { symbol: 'frxEURUSD', quote: 1.12118, epoch: 1792440872 },
      }),
    );

    expect(market.updateStreamingMidQuote).toHaveBeenCalledWith(
      'EURUSD',
      1.12118,
      new Date(1792440872 * 1000),
      'paper-1',
      'DERIV',
      expect.any(Date),
    );
    service.onModuleDestroy();
  });

  it('bootstraps only completed M1 candles and rejects the still-open minute', async () => {
    const market = marketMock();
    const service = new DerivPublicFxStreamService(configWith(), market);
    const firstOpen = new Date('2026-10-19T10:59:00.000Z').getTime();
    const candles = Array.from({ length: 62 }, (_, index) => ({
      epoch: (firstOpen + index * 60_000) / 1000,
      open: 1.1 + index / 100_000,
      high: 1.1002 + index / 100_000,
      low: 1.0998 + index / 100_000,
      close: 1.1001 + index / 100_000,
    }));

    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({
        msg_type: 'candles',
        candles,
        echo_req: { ticks_history: 'frxEURUSD' },
      }),
    );

    expect(market.updateClosedM1Candles).toHaveBeenCalledTimes(1);
    const [instrument, rows, connectionId] = (market.updateClosedM1Candles as jest.Mock).mock
      .calls[0]!;
    expect(instrument).toBe('EURUSD');
    expect(connectionId).toBe('paper-1');
    expect(rows).toHaveLength(61);
    expect(rows.at(-1).timestamp).toEqual(new Date('2026-10-19T11:59:00.000Z'));
    expect(
      rows.every(
        (row: { timestamp: Date }) => row.timestamp < new Date('2026-10-19T12:00:00.000Z'),
      ),
    ).toBe(true);
    expect(market.hasContiguousM1History).toHaveBeenCalledWith(
      'EURUSD',
      60,
      new Date('2026-10-19T11:59:00.000Z'),
      'paper-1',
    );
    service.onModuleDestroy();
  });

  it('recycles a connected Deriv socket that stops delivering ticks so marks can fall back to M5', async () => {
    const market = marketMock();
    const service = new DerivPublicFxStreamService(configWith(), market);

    (service as unknown as { connect(): void }).connect();
    const socket = FakeWebSocket.last!;
    socket.emit('open');
    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({
        msg_type: 'tick',
        tick: { symbol: 'frxEURUSD', quote: 1.12118, epoch: Date.now() / 1000 },
      }),
    );

    jest.advanceTimersByTime(50_000);
    expect(socket.closed).toBe(true);

    jest.advanceTimersByTime(5_000);
    expect(FakeWebSocket.last).not.toBe(socket);
    service.onModuleDestroy();
  });

  it('recycles the Deriv socket when one subscribed pair goes stale while other pairs still tick', async () => {
    const market = marketMock();
    const service = new DerivPublicFxStreamService(configWith(), market);

    (service as unknown as { connect(): void }).connect();
    const socket = FakeWebSocket.last!;
    socket.emit('open');
    const symbols = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'frxUSDCHF'];
    for (const symbol of symbols) {
      await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
        JSON.stringify({
          msg_type: 'tick',
          tick: { symbol, quote: 1.12118, epoch: Date.now() / 1000 },
        }),
      );
    }

    jest.advanceTimersByTime(40_000);
    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({
        msg_type: 'tick',
        tick: { symbol: 'frxEURUSD', quote: 1.12119, epoch: Date.now() / 1000 },
      }),
    );
    jest.advanceTimersByTime(10_000);

    expect(socket.closed).toBe(true);
    service.onModuleDestroy();
  });

  it('ignores a late close event from a recycled socket so the replacement watchdog stays armed', async () => {
    const market = marketMock();
    const service = new DerivPublicFxStreamService(configWith(), market);

    (service as unknown as { connect(): void }).connect();
    const oldSocket = FakeWebSocket.last!;
    oldSocket.emit('open');
    const symbols = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD', 'frxUSDCAD', 'frxUSDCHF'];
    for (const symbol of symbols) {
      await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
        JSON.stringify({
          msg_type: 'tick',
          tick: { symbol, quote: 1.12118, epoch: Date.now() / 1000 },
        }),
      );
    }

    jest.advanceTimersByTime(50_000);
    expect(oldSocket.closed).toBe(true);
    jest.advanceTimersByTime(5_000);
    const replacement = FakeWebSocket.last!;
    expect(replacement).not.toBe(oldSocket);
    replacement.emit('open');

    oldSocket.emit('close');
    jest.advanceTimersByTime(50_000);

    expect(replacement.closed).toBe(true);
    service.onModuleDestroy();
  });

  it('does not connect when Deriv is not the selected fast-mark provider', () => {
    const service = new DerivPublicFxStreamService(
      configWith({ 'vpsForexScanner.fastMarkProvider': 'TWELVE_DATA' }),
      marketMock(),
    );

    (service as unknown as { connect(): void }).connect();
    expect(FakeWebSocket.last).toBeNull();
    service.onModuleDestroy();
  });

  it('stays disconnected while the FX weekly session is closed', () => {
    const service = new DerivPublicFxStreamService(configWith(), marketMock());
    jest.setSystemTime(new Date('2026-10-17T12:00:00.000Z'));

    (service as unknown as { reconcileMarketSession(): void }).reconcileMarketSession();

    expect(FakeWebSocket.last).toBeNull();
    service.onModuleDestroy();
  });
});
