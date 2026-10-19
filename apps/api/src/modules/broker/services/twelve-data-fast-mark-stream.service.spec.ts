import { ConfigService } from '@nestjs/config';
import { TwelveDataFastMarkStreamService } from './twelve-data-fast-mark-stream.service';
import { LivePaperMarketDataService } from './live-paper-market-data.service';
import { PaperBrokerStateService } from './paper-broker-state.service';

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

describe('TwelveDataFastMarkStreamService', () => {
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
  });

  afterEach(() => {
    const target = globalThis as unknown as { WebSocket?: unknown };
    if (originalWebSocket === undefined) delete target.WebSocket;
    else target.WebSocket = originalWebSocket;
    FakeWebSocket.last = null;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('keeps the fast-mark socket off while FX is closed and reconnects when the session opens', () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
        };
        return key in values ? values[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = { updateStreamingMidQuote: jest.fn() } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);
    const reconcile = (service as unknown as { reconcileMarketSession(): void })
      .reconcileMarketSession;

    expect(typeof reconcile).toBe('function');
    jest.setSystemTime(new Date('2026-10-17T12:00:00.000Z'));
    reconcile.call(service);
    expect(FakeWebSocket.last).toBeNull();

    jest.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    reconcile.call(service);
    expect(FakeWebSocket.last).not.toBeNull();
    service.onModuleDestroy();
  });

  it('does not schedule reconnect attempts while the FX weekly session is closed', () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
        };
        return key in values ? values[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = { updateStreamingMidQuote: jest.fn() } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);

    jest.setSystemTime(new Date('2026-10-17T12:00:00.000Z'));
    (service as unknown as { scheduleReconnect(): void }).scheduleReconnect();

    expect(
      (service as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer,
    ).toBeNull();
    service.onModuleDestroy();
  });

  it('subscribes only to the selected fast-mark pair and routes its price', () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
        };
        return key in values ? values[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = { updateStreamingMidQuote: jest.fn() } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);

    (service as unknown as { connect(): void }).connect();
    const socket = FakeWebSocket.last!;
    socket.emit('open');
    const subscribe = JSON.parse(socket.sent[0]!) as {
      action: string;
      params: { symbols: string };
    };
    expect(subscribe.action).toBe('subscribe');
    expect(subscribe.params.symbols).toBe('EUR/USD');

    socket.emit('message', {
      data: JSON.stringify({ symbol: 'EUR/USD', price: '1.12345', timestamp: 1790875800 }),
    });
    expect(market.updateStreamingMidQuote).toHaveBeenCalledWith(
      'EURUSD',
      1.12345,
      new Date(1790875800 * 1000),
      undefined,
    );
    service.onModuleDestroy();
    expect(socket.closed).toBe(true);
  });

  it('falls back to EUR/USD when the selected pair is rejected by the entitlement', () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
        };
        return key in values ? values[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = { updateStreamingMidQuote: jest.fn() } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);
    (service as unknown as { preferredProviderSymbol: string }).preferredProviderSymbol = 'USD/JPY';

    (service as unknown as { connect(): void }).connect();
    const socket = FakeWebSocket.last!;
    socket.emit('open');
    expect(JSON.parse(socket.sent[0]!).params.symbols).toBe('USD/JPY');

    socket.emit('message', {
      data: JSON.stringify({
        event: 'subscribe-status',
        success: [],
        fails: [{ symbol: 'USD/JPY' }],
      }),
    });
    expect(JSON.parse(socket.sent[1]!).params.symbols).toBe('EUR/USD');
    service.onModuleDestroy();
  });

  it('deduplicates M1 bootstrap within a minute and refreshes it after a later accepted reconnect', async () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const values = Array.from({ length: 70 }, (_, index) => {
      const timestamp = new Date(Date.UTC(2026, 9, 19, 10, 50 + index));
      return {
        datetime: timestamp.toISOString().slice(0, 19).replace('T', ' '),
        open: '1.10000',
        high: '1.10020',
        low: '1.09980',
        close: '1.10010',
      };
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'ok', values }),
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const configured: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
          'vpsForexScanner.brokerConnectionId': 'paper-1',
        };
        return key in configured ? configured[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = {
      updateStreamingMidQuote: jest.fn(),
      updateClosedM1Candles: jest.fn(),
      hasContiguousM1History: jest.fn().mockReturnValue(true),
    } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);

    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ event: 'subscribe-status', success: [{ symbol: 'EUR/USD' }], fails: [] }),
    );
    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ event: 'subscribe-status', success: [{ symbol: 'EUR/USD' }], fails: [] }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-10-19T12:02:00.000Z'));
    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ event: 'subscribe-status', success: [{ symbol: 'EUR/USD' }], fails: [] }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('interval=1min');
    expect(url).toContain('symbol=EUR%2FUSD');
    expect(url).toContain('outputsize=100');
    expect(market.updateClosedM1Candles).toHaveBeenCalledTimes(2);
    const [instrument, rows, connectionId] = (market.updateClosedM1Candles as jest.Mock).mock
      .calls[0]!;
    expect(instrument).toBe('EURUSD');
    expect(connectionId).toBe('paper-1');
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(
      rows.every(
        (row: { timestamp: Date }) => row.timestamp < new Date('2026-10-19T12:00:00.000Z'),
      ),
    ).toBe(true);
    service.onModuleDestroy();
  });

  it('repairs a provider-lagged startup M1 gap with bounded delayed REST bootstrap', async () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const history = (latestOpen: string) => {
      const latestMs = new Date(latestOpen).getTime();
      return Array.from({ length: 70 }, (_, index) => {
        const timestamp = new Date(latestMs - (69 - index) * 60_000);
        return {
          datetime: timestamp.toISOString().slice(0, 19).replace('T', ' '),
          open: '1.10000',
          high: '1.10020',
          low: '1.09980',
          close: '1.10010',
        };
      });
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: jest
          .fn()
          .mockResolvedValue({ status: 'ok', values: history('2026-10-19T11:58:00.000Z') }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: jest
          .fn()
          .mockResolvedValue({ status: 'ok', values: history('2026-10-19T11:59:00.000Z') }),
      });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const configured: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
          'vpsForexScanner.brokerConnectionId': 'paper-1',
        };
        return key in configured ? configured[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = {
      updateStreamingMidQuote: jest.fn(),
      updateClosedM1Candles: jest.fn(),
      hasContiguousM1History: jest.fn().mockReturnValueOnce(false).mockReturnValue(true),
    } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);

    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ event: 'subscribe-status', success: [{ symbol: 'EUR/USD' }], fails: [] }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(market.updateClosedM1Candles).toHaveBeenCalledTimes(2);
    expect(market.hasContiguousM1History).toHaveBeenLastCalledWith(
      'EURUSD',
      60,
      new Date('2026-10-19T11:59:00.000Z'),
      'paper-1',
    );

    await jest.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('stops startup continuity REST repair after three failed attempts', async () => {
    const values = Array.from({ length: 70 }, (_, index) => {
      const timestamp = new Date(
        new Date('2026-10-19T11:58:00.000Z').getTime() - (69 - index) * 60_000,
      );
      return {
        datetime: timestamp.toISOString().slice(0, 19).replace('T', ' '),
        open: '1.10000',
        high: '1.10020',
        low: '1.09980',
        close: '1.10010',
      };
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'ok', values }),
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const configured: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
          'vpsForexScanner.brokerConnectionId': 'paper-1',
        };
        return key in configured ? configured[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = {
      updateClosedM1Candles: jest.fn(),
      hasContiguousM1History: jest.fn().mockReturnValue(false),
    } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);

    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ event: 'subscribe-status', success: [{ symbol: 'EUR/USD' }], fails: [] }),
    );
    await jest.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    service.onModuleDestroy();
  });

  it('retries a transient initial M1 bootstrap failure and stops once real REST continuity is restored', async () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const values = Array.from({ length: 70 }, (_, index) => {
      const timestamp = new Date(Date.UTC(2026, 9, 19, 10, 50 + index));
      return {
        datetime: timestamp.toISOString().slice(0, 19).replace('T', ' '),
        open: '1.10000',
        high: '1.10020',
        low: '1.09980',
        close: '1.10010',
      };
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ status: 'ok', values }),
      });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const configured: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
          'vpsForexScanner.brokerConnectionId': 'paper-1',
        };
        return key in configured ? configured[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = {
      updateStreamingMidQuote: jest.fn(),
      updateClosedM1Candles: jest.fn(),
      hasContiguousM1History: jest.fn().mockReturnValue(true),
    } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);

    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ event: 'subscribe-status', success: [{ symbol: 'EUR/USD' }], fails: [] }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(market.updateClosedM1Candles).toHaveBeenCalledTimes(1);
    expect(market.hasContiguousM1History).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('does not bootstrap a rejected entitlement symbol before EUR/USD fallback is accepted', async () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'ok', values: [] }),
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const configured: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': true,
          'vpsForexScanner.apiKey': 'test-key',
          'vpsForexScanner.brokerConnectionId': 'paper-1',
        };
        return key in configured ? configured[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = {
      updateStreamingMidQuote: jest.fn(),
      updateClosedM1Candles: jest.fn(),
    } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);
    (service as unknown as { preferredProviderSymbol: string }).preferredProviderSymbol = 'USD/JPY';
    (service as unknown as { socket: FakeWebSocket | null }).socket = new FakeWebSocket('test');

    await (service as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ event: 'subscribe-status', success: [], fails: [{ symbol: 'USD/JPY' }] }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(market.updateClosedM1Candles).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('does not connect when fast marks are disabled', () => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          'vpsForexScanner.enabled': true,
          'vpsForexScanner.fastMarkStreamEnabled': false,
          'vpsForexScanner.apiKey': 'test-key',
        };
        return key in values ? values[key] : fallback;
      }),
    } as unknown as ConfigService;
    const market = { updateStreamingMidQuote: jest.fn() } as unknown as LivePaperMarketDataService;
    const paperState = { load: jest.fn() } as unknown as PaperBrokerStateService;
    const service = new TwelveDataFastMarkStreamService(config, market, paperState);
    (service as unknown as { connect(): void }).connect();
    expect(FakeWebSocket.last).toBeNull();
    service.onModuleDestroy();
  });
});
