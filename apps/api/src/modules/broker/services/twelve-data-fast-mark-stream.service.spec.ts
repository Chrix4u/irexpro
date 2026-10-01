import { ConfigService } from '@nestjs/config';
import { TwelveDataFastMarkStreamService } from './twelve-data-fast-mark-stream.service';
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

describe('TwelveDataFastMarkStreamService', () => {
  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;

  afterEach(() => {
    const target = globalThis as unknown as { WebSocket?: unknown };
    if (originalWebSocket === undefined) delete target.WebSocket;
    else target.WebSocket = originalWebSocket;
    FakeWebSocket.last = null;
    jest.restoreAllMocks();
  });

  it('subscribes to six pairs and routes a price event into the mark-only cache', () => {
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
    const service = new TwelveDataFastMarkStreamService(config, market);

    (service as unknown as { connect(): void }).connect();
    const socket = FakeWebSocket.last!;
    socket.emit('open');
    const subscribe = JSON.parse(socket.sent[0]!) as {
      action: string;
      params: { symbols: string };
    };
    expect(subscribe.action).toBe('subscribe');
    expect(subscribe.params.symbols.split(',')).toEqual([
      'EUR/USD',
      'GBP/USD',
      'USD/JPY',
      'AUD/USD',
      'USD/CAD',
      'USD/CHF',
    ]);

    socket.emit('message', {
      data: JSON.stringify({ symbol: 'EUR/USD', price: '1.12345', timestamp: 1790875800 }),
    });
    expect(market.updateStreamingMidQuote).toHaveBeenCalledWith(
      'EURUSD',
      1.12345,
      new Date(1790875800 * 1000),
    );
    service.onModuleDestroy();
    expect(socket.closed).toBe(true);
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
    const service = new TwelveDataFastMarkStreamService(config, market);
    (service as unknown as { connect(): void }).connect();
    expect(FakeWebSocket.last).toBeNull();
    service.onModuleDestroy();
  });
});
