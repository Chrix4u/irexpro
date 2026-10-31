import { Injectable, Optional } from '@nestjs/common';
import {
  BrokerAccountInfo, BrokerBalance, BrokerCloseAllResult, BrokerClosedTrade, BrokerConnectionResult,
  BrokerConnectionTestResult, BrokerInstrument, BrokerMode, BrokerOrderModification, BrokerOrderRequest,
  BrokerOrderResult, BrokerOrderState, BrokerPosition, BrokerPrice, DecryptedBrokerCredentials, IBrokerAdapter,
  OHLCV, RequiredMarginParams,
} from '../../interfaces/broker-adapter.interface';
import { OrderCapabilityDeclaration } from '../../interfaces/order-capability';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import { ProviderDispatchCertainty } from '../../interfaces/provider-dispatch-certainty';
import { DirectMt5CommandService, DirectMt5CommandUncertainError } from '../../direct-mt5/direct-mt5-command.service';

const req = {
  MARKET: { limitPriceRequired: false, stopPriceRequired: false },
  LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
  STOP: { limitPriceRequired: false, stopPriceRequired: true },
  STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
} as const;

@Injectable()
export class DirectMt5Adapter implements IBrokerAdapter {
  readonly brokerId = 'direct-mt5';
  readonly brokerName = 'MetaTrader 5 — Direct Terminal';
  readonly supportsDemo = true;
  private mode: BrokerMode = BrokerMode.DEMO;
  private connected = false;

  constructor(private readonly commands: DirectMt5CommandService, @Optional() private readonly connectionId?: string) {}

  setMode(mode: BrokerMode): void {
    this.mode = mode;
  }
  private id(): string {
    if (!this.connectionId) throw new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'Direct MT5 adapter requires a persisted broker connection');
    return this.connectionId;
  }
  async connect(_credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    this.setMode(this.mode);
    const c = await this.commands.getActiveConnectorForConnection(this.id());
    const observedMode = c.accountType === 'LIVE' ? BrokerMode.LIVE : BrokerMode.DEMO;
    if (observedMode !== this.mode) {
      throw new BrokerAdapterError(
        BrokerErrorCode.ENVIRONMENT_MISMATCH,
        `Direct MT5 terminal environment mismatch: expected ${this.mode}, observed ${observedMode}`,
      );
    }
    this.connected = true;
    return { success: true, accountId: c.accountLogin, accountType: observedMode, currency: c.currency, serverTime: new Date() };
  }
  async disconnect(): Promise<void> { this.connected = false; }
  async testConnection(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionTestResult> {
    try { const r = await this.connect(credentials); return { success: true, accountId: r.accountId, accountType: r.accountType, currency: r.currency ?? undefined }; }
    catch (e) { return { success: false, errorCode: 'DIRECT_MT5_NOT_READY', errorMessage: e instanceof Error ? e.message : 'Direct MT5 not ready' }; }
  }
  isConnected(): boolean { return this.connected; }
  private async read(type: any, payload: Record<string, unknown>, suffix: string): Promise<Record<string, unknown>> {
    return this.commands.request({ brokerConnectionId: this.id(), idempotencyKey: `read:${suffix}:${Date.now()}:${Math.random().toString(36).slice(2)}`, commandType: type, payload });
  }
  private async mutate(type: any, payload: Record<string, unknown>, key: string): Promise<Record<string, unknown>> {
    try { return await this.commands.request({ brokerConnectionId: this.id(), idempotencyKey: key, commandType: type, payload }); }
    catch (e) {
      if (e instanceof DirectMt5CommandUncertainError) throw new BrokerAdapterError(BrokerErrorCode.CONNECTION_TIMEOUT, e.message, undefined, false, ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER);
      throw e;
    }
  }
  private providerDate(value: unknown, field: string): Date {
    const parsed = new Date(String(value ?? ''));
    if (!Number.isFinite(parsed.getTime())) {
      throw new BrokerAdapterError(BrokerErrorCode.BROKER_SERVER_ERROR, `Direct MT5 returned invalid ${field}`);
    }
    return parsed;
  }
  private normalizePosition(value: unknown): BrokerPosition {
    const p = value as Record<string, unknown>;
    return { ...p, openedAt: this.providerDate(p.openedAt, 'position openedAt'), markObservedAt: p.markObservedAt ? this.providerDate(p.markObservedAt, 'position markObservedAt') : undefined } as unknown as BrokerPosition;
  }
  private normalizeOrder(value: unknown): BrokerOrderState {
    const o = value as Record<string, unknown>;
    return { ...o, placedAt: o.placedAt ? this.providerDate(o.placedAt, 'order placedAt') : null, updatedAt: o.updatedAt ? this.providerDate(o.updatedAt, 'order updatedAt') : null } as unknown as BrokerOrderState;
  }
  async getAccountInfo(): Promise<BrokerAccountInfo> { return (await this.read('ACCOUNT_SNAPSHOT', {}, 'account')) as unknown as BrokerAccountInfo; }
  async getAccountBalance(): Promise<BrokerBalance> { const a = await this.getAccountInfo(); return { balance: a.balance, equity: a.equity, currency: a.currency ?? '', timestamp: new Date() }; }
  async getOpenPositions(): Promise<BrokerPosition[]> { const r = await this.read('LIST_POSITIONS', {}, 'positions'); return Array.isArray(r.positions) ? r.positions.map((p) => this.normalizePosition(p)) : []; }
  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> { return (await this.getOpenPositions()).find((p:any) => String(p.externalOrderId ?? p.id) === externalOrderId) ?? null; }
  async getRequiredMargin(params: RequiredMarginParams): Promise<string | null> { const r = await this.read('CALCULATE_MARGIN', params as unknown as Record<string, unknown>, `margin:${params.instrument}:${params.lotSize}`); return typeof r.margin === 'string' ? r.margin : null; }
  getOrderCapabilities(): OrderCapabilityDeclaration { return { brokerId: this.brokerId, supportedOrderKinds: ['MARKET'], requirements: req, marketSlTpAttachedAtPlacement: true }; }
  async getInstrumentList(): Promise<BrokerInstrument[]> { const r = await this.read('LIST_SYMBOLS', {}, 'symbols'); return (r.instruments ?? []) as BrokerInstrument[]; }
  async getCurrentPrice(instrument: string): Promise<BrokerPrice> { const r = await this.read('GET_PRICE', { instrument }, `price:${instrument}`); return { ...r, timestamp: this.providerDate(r.timestamp, 'price timestamp') } as unknown as BrokerPrice; }
  async getOHLCV(instrument: string, timeframe: string, count: number, before?: Date): Promise<OHLCV[]> { const r = await this.read('GET_OHLCV', { instrument, timeframe, count, before: before?.toISOString() }, `ohlcv:${instrument}:${timeframe}`); return Array.isArray(r.bars) ? r.bars.map((bar) => { const b = bar as Record<string, unknown>; return { ...b, timestamp: this.providerDate(b.timestamp, 'candle timestamp') } as unknown as OHLCV; }) : []; }
  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    if ((order.orderKind ?? 'MARKET') !== 'MARKET') throw new BrokerAdapterError(BrokerErrorCode.INVALID_ORDER_TYPE, 'Direct MT5 currently supports MARKET entry orders only', undefined, false, ProviderDispatchCertainty.DEFINITELY_NOT_SENT);
    const r = await this.mutate('PLACE_ORDER', order as unknown as Record<string, unknown>, order.idempotencyKey);
    const success = r.success === true;
    return { success, externalOrderId: r.ticket != null ? String(r.ticket) : undefined, filledPrice: r.filledPrice != null ? String(r.filledPrice) : undefined, filledQuantity: r.filledQuantity != null ? String(r.filledQuantity) : order.lotSize, filledAt: r.filledAt ? new Date(String(r.filledAt)) : new Date(), status: success ? 'FILLED' : 'FAILED', brokerMessage: typeof r.message === 'string' ? r.message : undefined, rawResponse: r };
  }
  async modifyOrder(externalOrderId: string, modifications: BrokerOrderModification): Promise<BrokerOrderResult> { const r = await this.mutate('MODIFY_ORDER', { externalOrderId, ...modifications }, `modify:${externalOrderId}:${JSON.stringify(modifications)}`); return { success: r.success === true, externalOrderId, status: r.success === true ? 'FILLED' : 'FAILED', rawResponse: r }; }
  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> { const r = await this.mutate('CLOSE_ORDER', { externalOrderId, lotSize }, `close:${externalOrderId}:${lotSize ?? 'all'}`); return { success: r.success === true, externalOrderId, filledPrice: r.filledPrice != null ? String(r.filledPrice) : undefined, realisedPnl: r.realisedPnl != null ? String(r.realisedPnl) : undefined, status: r.success === true ? 'FILLED' : 'FAILED', rawResponse: r }; }
  async closeAllOrders(): Promise<BrokerCloseAllResult> { const r = await this.mutate('CLOSE_ALL', {}, `close-all:${Date.now()}`); return { closedCount: Number(r.closedCount ?? 0), failedCount: Number(r.failedCount ?? 0), errors: Array.isArray(r.errors) ? r.errors.map(String) : [] }; }
  async getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]> { const r = await this.read('GET_HISTORY', { from: from.toISOString(), to: to.toISOString() }, `history:${from.toISOString()}:${to.toISOString()}`); return Array.isArray(r.trades) ? r.trades.map((trade) => { const t = trade as Record<string, unknown>; return { ...t, openedAt: this.providerDate(t.openedAt, 'trade openedAt'), closedAt: this.providerDate(t.closedAt, 'trade closedAt') } as unknown as BrokerClosedTrade; }) : []; }
  async listOrders(): Promise<BrokerOrderState[]> { const r = await this.read('LIST_ORDERS', {}, 'orders'); return Array.isArray(r.orders) ? r.orders.map((o) => this.normalizeOrder(o)) : []; }
  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> { const r = await this.read('GET_ORDER', { providerOrderId }, `order:${providerOrderId}`); return r.order ? this.normalizeOrder(r.order) : null; }
}
