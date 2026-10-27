import { randomUUID } from 'crypto';
import { Injectable, Optional } from '@nestjs/common';
import {
  BrokerAccountInfo,
  BrokerBalance,
  BrokerCloseAllResult,
  BrokerClosedTrade,
  BrokerConnectionResult,
  BrokerConnectionTestResult,
  BrokerInstrument,
  BrokerMode,
  BrokerOrderModification,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
  BrokerPosition,
  BrokerPrice,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
  OHLCV,
  RequiredMarginParams,
} from '../../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';
import type { OrderCapabilityDeclaration } from '../../interfaces/order-capability';
import { assertOrderWithinCapabilities } from '../../interfaces/order-capability';
import { ProviderDispatchCertainty } from '../../interfaces/provider-dispatch-certainty';
import {
  buildMt5BridgeCommand,
  Mt5BridgeAccountIdentity,
  Mt5BridgeCommandName,
  Mt5BridgeResponse,
} from './mt5-bridge-protocol';
import {
  Mt5BridgeSessionRegistry,
  Mt5BridgeSessionRegistryError,
} from './mt5-bridge-session-registry.service';

const MT5_NATIVE_MAGIC = 2601025;
const MT5_NATIVE_COMMENT_PREFIX = 'IREXPRO:';
const MUTATION_TTL_MS = 30_000;

interface AccountPayload {
  accountId: string;
  currency: string | null;
  leverage: number;
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  marginLevel: string;
}

interface InstrumentsPayload {
  instruments: BrokerInstrument[];
}

interface TickPayload {
  instrument: string;
  bid: string;
  ask: string;
  timestamp: string;
}

interface RatesPayload {
  candles: Array<{
    timestamp: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    brokerTime?: string;
    tickVolume?: string;
    tradeVolume?: string;
    spreadPoints?: string;
    priceDigits?: number;
  }>;
}

interface MarginPayload {
  requiredMargin: string | null;
}

interface PositionsPayload {
  positions: BrokerPosition[];
}

interface OrdersPayload {
  orders: BrokerOrderState[];
}

interface OrderPayload {
  order: BrokerOrderState | null;
}

interface HistoryPayload {
  trades: BrokerClosedTrade[];
}

interface OrderResultPayload {
  success: boolean;
  providerOrderId?: string;
  status: BrokerOrderResult['status'];
  filledPrice?: string;
  filledQuantity?: string;
  filledAt?: string;
  realisedPnl?: string;
  commission?: string;
  swap?: string;
  brokerMessage?: string;
}

type CloseAllPayload = BrokerCloseAllResult;

/**
 * First-party MetaTrader 5 adapter backed by the iRexPro Bridge EA.
 *
 * Phase-1 authority is DEMO-only. The adapter never receives or stores an MT5
 * broker password: the EA runs inside an already-authenticated terminal and
 * the session registry binds the persisted BrokerConnection.id to the exact
 * MT5 account identity reported by that terminal.
 */
@Injectable()
export class NativeMetaTrader5Adapter implements IBrokerAdapter {
  readonly brokerId = 'metatrader5-native';
  readonly brokerName = 'MetaTrader 5 — iRexPro Native Bridge';
  readonly supportsDemo = true;

  private mode: BrokerMode = BrokerMode.DEMO;
  private connected = false;
  private expectedIdentity: Mt5BridgeAccountIdentity | null = null;
  private sequence = 0;

  constructor(
    private readonly sessions: Mt5BridgeSessionRegistry,
    @Optional() private readonly connectionId?: string,
  ) {}

  setMode(mode: BrokerMode): void {
    this.mode = mode;
  }

  async connect(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    const connectionId = this.resolveConnectionId(credentials);
    try {
      if (this.mode !== BrokerMode.DEMO) {
        throw new BrokerAdapterError(
          BrokerErrorCode.ENVIRONMENT_MISMATCH,
          'Native MT5 bridge is DEMO-only until provider-specific LIVE certification completes',
          undefined,
          false,
          ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
        );
      }
      const session = this.sessions.getHealthySession(connectionId);
      if (session.identity.environment !== 'DEMO') {
        throw new BrokerAdapterError(
          BrokerErrorCode.ENVIRONMENT_MISMATCH,
          `Paired MT5 terminal reports ${session.identity.environment}; DEMO is required`,
          undefined,
          false,
          ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
        );
      }
      if (credentials.accountId.trim() !== session.identity.accountLogin) {
        throw new BrokerAdapterError(
          BrokerErrorCode.AUTHENTICATION_FAILED,
          'Paired MT5 account identity does not match the stored broker account',
          undefined,
          false,
          ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
        );
      }

      this.expectedIdentity = { ...session.identity };
      this.sequence = this.sessions.currentSequence(connectionId);
      this.connected = true;
      return {
        success: true,
        accountId: session.identity.accountLogin,
        accountType: BrokerMode.DEMO,
        currency: session.identity.currency || null,
        serverTime: new Date(),
      };
    } catch (error) {
      this.connected = false;
      this.expectedIdentity = null;
      throw this.mapError(error);
    }
  }

  async disconnect(): Promise<void> {
    // The EA owns its outbound transport lifetime; disconnecting an iRexPro
    // BrokerConnection only clears this adapter context. The durable broker
    // authorization state is revoked by BrokerService before this call.
    this.connected = false;
    this.expectedIdentity = null;
  }

  async testConnection(
    credentials: DecryptedBrokerCredentials,
  ): Promise<BrokerConnectionTestResult> {
    try {
      const result = await this.connect(credentials);
      return {
        success: true,
        accountId: result.accountId,
        accountType: result.accountType,
        currency: result.currency ?? undefined,
      };
    } catch (error) {
      const mapped = this.mapError(error);
      return {
        success: false,
        errorCode: mapped.code,
        errorMessage: mapped.message,
      };
    }
  }

  isConnected(): boolean {
    if (!this.connected || !this.expectedIdentity) return false;
    try {
      this.sessions.getHealthySession(this.requireConnectionId(), this.expectedIdentity);
      return true;
    } catch {
      return false;
    }
  }

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    const payload = await this.read<AccountPayload>('GET_ACCOUNT_INFO', {});
    this.assertAccountPayload(payload);
    return {
      accountId: String(payload.accountId),
      currency: payload.currency ?? null,
      leverage: this.nonNegativeInteger(payload.leverage, 'leverage'),
      balance: this.decimal(payload.balance, 'balance'),
      equity: this.decimal(payload.equity, 'equity'),
      margin: this.decimal(payload.margin, 'margin'),
      freeMargin: this.decimal(payload.freeMargin, 'freeMargin'),
      marginLevel: this.decimal(payload.marginLevel, 'marginLevel'),
    };
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    const account = await this.getAccountInfo();
    if (!account.currency) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        'MT5 account currency is unavailable',
      );
    }
    return {
      balance: account.balance,
      equity: account.equity,
      currency: account.currency,
      timestamp: new Date(),
    };
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    const payload = await this.read<PositionsPayload>('LIST_POSITIONS', {});
    return (payload.positions ?? []).map((position) => this.normalizePosition(position));
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    const positions = await this.getOpenPositions();
    return positions.find((position) => position.externalOrderId === externalOrderId) ?? null;
  }

  async getRequiredMargin(params: RequiredMarginParams): Promise<string | null> {
    try {
      const payload = await this.read<MarginPayload>('CALCULATE_MARGIN', {
        instrument: params.instrument,
        lotSize: this.positiveDecimal(params.lotSize, 'lotSize'),
        direction: params.direction,
      });
      if (payload.requiredMargin == null) return null;
      return this.decimal(payload.requiredMargin, 'requiredMargin');
    } catch {
      return null;
    }
  }

  getOrderCapabilities(): OrderCapabilityDeclaration {
    return {
      brokerId: this.brokerId,
      supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'],
      requirements: {
        MARKET: { limitPriceRequired: false, stopPriceRequired: false },
        LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
        STOP: { limitPriceRequired: false, stopPriceRequired: true },
        STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
      },
      marketSlTpAttachedAtPlacement: true,
    };
  }

  async getInstrumentList(): Promise<BrokerInstrument[]> {
    const payload = await this.read<InstrumentsPayload>('GET_SYMBOLS', {});
    return (payload.instruments ?? []).map((instrument) => ({
      symbol: String(instrument.symbol),
      description: String(instrument.description ?? instrument.symbol),
      digits: this.nonNegativeInteger(instrument.digits, 'digits'),
      minLot: this.positiveDecimal(instrument.minLot, 'minLot'),
      maxLot: this.positiveDecimal(instrument.maxLot, 'maxLot'),
      lotStep: this.positiveDecimal(instrument.lotStep, 'lotStep'),
      contractSize: this.positiveDecimal(instrument.contractSize, 'contractSize'),
    }));
  }

  async getCurrentPrice(instrument: string): Promise<BrokerPrice> {
    const payload = await this.read<TickPayload>('GET_TICK', { instrument });
    const bid = this.positiveDecimal(payload.bid, 'bid');
    const ask = this.positiveDecimal(payload.ask, 'ask');
    const bidNumber = Number(bid);
    const askNumber = Number(ask);
    if (askNumber < bidNumber) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        'MT5 bridge returned ask below bid',
      );
    }
    return {
      instrument: String(payload.instrument || instrument),
      bid,
      ask,
      spread: this.spreadDecimal(bid, ask),
      timestamp: this.date(payload.timestamp, 'tick.timestamp'),
    };
  }

  async getOHLCV(
    instrument: string,
    timeframe: string,
    count: number,
    before: Date = new Date(),
  ): Promise<OHLCV[]> {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new BrokerAdapterError(BrokerErrorCode.INVALID_REQUEST, 'Candle count must be >= 0');
    }
    if (count === 0) return [];
    const payload = await this.read<RatesPayload>('GET_RATES', {
      instrument,
      timeframe,
      count,
      before: before.toISOString(),
    });
    return (payload.candles ?? []).map((candle) => ({
      timestamp: this.date(candle.timestamp, 'candle.timestamp'),
      open: this.decimal(candle.open, 'candle.open'),
      high: this.decimal(candle.high, 'candle.high'),
      low: this.decimal(candle.low, 'candle.low'),
      close: this.decimal(candle.close, 'candle.close'),
      volume: this.decimal(candle.volume, 'candle.volume'),
      brokerTime: candle.brokerTime,
      tickVolume:
        candle.tickVolume === undefined
          ? undefined
          : this.decimal(candle.tickVolume, 'candle.tickVolume'),
      tradeVolume:
        candle.tradeVolume === undefined
          ? undefined
          : this.decimal(candle.tradeVolume, 'candle.tradeVolume'),
      spreadPoints:
        candle.spreadPoints === undefined
          ? undefined
          : this.decimal(candle.spreadPoints, 'candle.spreadPoints'),
      priceDigits: candle.priceDigits,
    }));
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    assertOrderWithinCapabilities(order, this.getOrderCapabilities());
    this.positiveDecimal(order.lotSize, 'lotSize');
    const payload = await this.mutate<OrderResultPayload>(
      'PLACE_ORDER',
      {
        idempotencyKey: order.idempotencyKey,
        clientOrderId: order.clientOrderId ?? order.idempotencyKey,
        instrument: order.instrument,
        direction: order.direction,
        lotSize: order.lotSize,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        orderKind: order.orderKind ?? 'MARKET',
        timeInForce: order.timeInForce ?? 'GTC',
        limitPrice: order.limitPrice,
        stopPrice: order.stopPrice,
        comment: `${MT5_NATIVE_COMMENT_PREFIX}${order.clientOrderId ?? order.idempotencyKey}`,
        magicNumber: MT5_NATIVE_MAGIC,
      },
      order.idempotencyKey,
    );
    return this.mapOrderResult(payload);
  }

  async modifyOrder(
    externalOrderId: string,
    modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult> {
    if (
      modifications.newStopLoss === undefined &&
      modifications.newTakeProfit === undefined &&
      modifications.newTrailingStop === undefined
    ) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        'modifyOrder requires at least one modification',
        undefined,
        false,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
    const key = `modify:${externalOrderId}:${this.modificationIdentity(modifications)}`;
    const payload = await this.mutate<OrderResultPayload>(
      'MODIFY_ORDER',
      { externalOrderId, ...modifications },
      key,
    );
    return this.mapOrderResult(payload, externalOrderId);
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    if (lotSize !== undefined) this.positiveDecimal(lotSize, 'lotSize');
    const key = `close:${externalOrderId}:${lotSize ?? 'ALL'}`;
    const payload = await this.mutate<OrderResultPayload>(
      'CLOSE_POSITION',
      { externalOrderId, lotSize },
      key,
    );
    return this.mapOrderResult(payload, externalOrderId);
  }

  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    const payload = await this.mutate<CloseAllPayload>(
      'CLOSE_IREXPRO_POSITIONS',
      { magicNumber: MT5_NATIVE_MAGIC, commentPrefix: MT5_NATIVE_COMMENT_PREFIX },
      `close-all:${randomUUID()}`,
    );
    return {
      closedCount: this.nonNegativeInteger(payload.closedCount, 'closedCount'),
      failedCount: this.nonNegativeInteger(payload.failedCount, 'failedCount'),
      errors: Array.isArray(payload.errors) ? payload.errors.map(String) : [],
    };
  }

  async getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]> {
    const payload = await this.read<HistoryPayload>('GET_HISTORY', {
      from: from.toISOString(),
      to: to.toISOString(),
      ownership: { magicNumber: MT5_NATIVE_MAGIC, commentPrefix: MT5_NATIVE_COMMENT_PREFIX },
    });
    return (payload.trades ?? []).map((trade) => this.normalizeClosedTrade(trade));
  }

  async listOrders(): Promise<BrokerOrderState[]> {
    const payload = await this.read<OrdersPayload>('LIST_ORDERS', {
      ownership: { magicNumber: MT5_NATIVE_MAGIC, commentPrefix: MT5_NATIVE_COMMENT_PREFIX },
    });
    return (payload.orders ?? []).map((order) => this.normalizeOrderState(order));
  }

  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    const payload = await this.read<OrderPayload>('GET_ORDER', { providerOrderId });
    return payload.order ? this.normalizeOrderState(payload.order) : null;
  }

  /** Additive concrete surface used by provider-verification harnesses. */
  async cancelOrder(externalOrderId: string): Promise<BrokerOrderResult> {
    const payload = await this.mutate<OrderResultPayload>(
      'CANCEL_ORDER',
      { externalOrderId },
      `cancel:${externalOrderId}`,
    );
    return this.mapOrderResult(payload, externalOrderId);
  }

  private async read<T>(commandName: Mt5BridgeCommandName, payload: unknown): Promise<T> {
    return this.request<T>(commandName, payload);
  }

  private async mutate<T>(
    commandName: Mt5BridgeCommandName,
    payload: unknown,
    idempotencyKey: string,
  ): Promise<T> {
    return this.request<T>(commandName, payload, idempotencyKey);
  }

  private async request<T>(
    commandName: Mt5BridgeCommandName,
    payload: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const connectionId = this.requireConnectionId();
    const identity = this.requireIdentity();
    const session = this.sessions.getHealthySession(connectionId, identity);
    const sequence = ++this.sequence;
    const now = new Date();
    const command = buildMt5BridgeCommand({
      sessionId: session.sessionId,
      requestId: randomUUID(),
      sequence,
      nonce: randomUUID(),
      commandName,
      payload,
      signature: 'registry-authenticated',
      sentAt: now.toISOString(),
      idempotencyKey,
      expiresAt: idempotencyKey
        ? new Date(now.getTime() + MUTATION_TTL_MS).toISOString()
        : undefined,
      expectedIdentity: idempotencyKey ? identity : undefined,
      ownership: idempotencyKey
        ? { magicNumber: MT5_NATIVE_MAGIC, commentPrefix: MT5_NATIVE_COMMENT_PREFIX }
        : undefined,
    });

    try {
      const result = await this.sessions.request(connectionId, command);
      if (!result.ok) throw this.mapBridgeRejection(result);
      return (result.payload ?? {}) as T;
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private resolveConnectionId(credentials: DecryptedBrokerCredentials): string {
    const id =
      this.connectionId ??
      credentials.additionalParams?.bridgeConnectionId ??
      credentials.additionalParams?.connectionId;
    if (!id?.trim()) {
      throw new BrokerAdapterError(
        BrokerErrorCode.NOT_CONNECTED,
        'Native MT5 bridge requires a paired iRexPro broker connection id',
        undefined,
        false,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
    return id;
  }

  private requireConnectionId(): string {
    if (!this.connectionId?.trim()) {
      throw new BrokerAdapterError(
        BrokerErrorCode.NOT_CONNECTED,
        'Native MT5 adapter has no persisted connection binding',
        undefined,
        false,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
    return this.connectionId;
  }

  private requireIdentity(): Mt5BridgeAccountIdentity {
    if (!this.connected || !this.expectedIdentity) {
      throw new BrokerAdapterError(
        BrokerErrorCode.NOT_CONNECTED,
        'Native MT5 adapter is not connected',
        undefined,
        false,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
    return this.expectedIdentity;
  }

  private mapBridgeRejection(response: Mt5BridgeResponse): BrokerAdapterError {
    const code = String(response.error?.code ?? 'UNKNOWN').toUpperCase();
    const brokerCode = code.includes('MARGIN')
      ? BrokerErrorCode.INSUFFICIENT_MARGIN
      : code.includes('MARKET_CLOSED')
        ? BrokerErrorCode.MARKET_CLOSED
        : code.includes('SYMBOL')
          ? BrokerErrorCode.INVALID_INSTRUMENT
          : code.includes('POSITION') || code.includes('NOT_FOUND')
            ? BrokerErrorCode.POSITION_NOT_FOUND
            : code.includes('DUPLICATE')
              ? BrokerErrorCode.DUPLICATE_ORDER
              : BrokerErrorCode.INVALID_REQUEST;
    return new BrokerAdapterError(
      brokerCode,
      response.error?.message ?? `MT5 bridge rejected ${code}`,
      response.error?.message,
      false,
      ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED,
    );
  }

  private mapError(error: unknown): BrokerAdapterError {
    if (error instanceof BrokerAdapterError) return error;
    if (error instanceof Mt5BridgeSessionRegistryError) {
      switch (error.code) {
        case 'COMMAND_OUTCOME_UNCERTAIN':
          return new BrokerAdapterError(
            BrokerErrorCode.CONNECTION_TIMEOUT,
            'MT5 bridge command outcome is uncertain; reconciliation is required before retry',
            undefined,
            true,
            ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
          );
        case 'SESSION_REQUEST_TIMEOUT':
          return new BrokerAdapterError(
            BrokerErrorCode.CONNECTION_TIMEOUT,
            'MT5 bridge request timed out',
            undefined,
            true,
            ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
          );
        case 'SESSION_IDENTITY_MISMATCH':
        case 'ACCOUNT_ALREADY_BOUND':
          return new BrokerAdapterError(
            BrokerErrorCode.AUTHENTICATION_FAILED,
            'MT5 bridge account identity changed or is already bound elsewhere',
            undefined,
            false,
            ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
          );
        case 'SESSION_NOT_FOUND':
        case 'SESSION_STALE':
        case 'SESSION_TRADING_UNAVAILABLE':
        case 'SESSION_GENERATION_CHANGED':
          return new BrokerAdapterError(
            BrokerErrorCode.CONNECTION_LOST,
            `MT5 bridge session unavailable (${error.code})`,
            undefined,
            true,
            error.code === 'SESSION_GENERATION_CHANGED'
              ? ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER
              : ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
          );
        default:
          return new BrokerAdapterError(
            BrokerErrorCode.UNKNOWN,
            `MT5 bridge failure (${error.code})`,
            undefined,
            false,
            ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
          );
      }
    }
    return new BrokerAdapterError(
      BrokerErrorCode.UNKNOWN,
      error instanceof Error ? error.message : 'Unknown native MT5 bridge error',
      undefined,
      false,
      ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
    );
  }

  private mapOrderResult(payload: OrderResultPayload, fallbackId?: string): BrokerOrderResult {
    const status = ['FILLED', 'PENDING', 'REJECTED', 'FAILED'].includes(payload.status)
      ? payload.status
      : 'FAILED';
    return {
      success: payload.success === true,
      externalOrderId: payload.providerOrderId ?? fallbackId,
      filledPrice:
        payload.filledPrice === undefined
          ? undefined
          : this.decimal(payload.filledPrice, 'filledPrice'),
      filledQuantity:
        payload.filledQuantity === undefined
          ? undefined
          : this.decimal(payload.filledQuantity, 'filledQuantity'),
      filledAt: payload.filledAt ? this.date(payload.filledAt, 'filledAt') : undefined,
      realisedPnl:
        payload.realisedPnl === undefined
          ? undefined
          : this.decimal(payload.realisedPnl, 'realisedPnl'),
      commission:
        payload.commission === undefined
          ? undefined
          : this.decimal(payload.commission, 'commission'),
      swap: payload.swap === undefined ? undefined : this.decimal(payload.swap, 'swap'),
      status: status as BrokerOrderResult['status'],
      brokerMessage: payload.brokerMessage,
    };
  }

  private normalizePosition(position: BrokerPosition): BrokerPosition {
    return {
      ...position,
      externalOrderId: String(position.externalOrderId),
      instrument: String(position.instrument),
      direction: position.direction,
      lotSize: this.decimal(position.lotSize, 'position.lotSize'),
      openPrice: this.decimal(position.openPrice, 'position.openPrice'),
      currentPrice: this.decimal(position.currentPrice, 'position.currentPrice'),
      stopLoss: this.decimal(position.stopLoss, 'position.stopLoss'),
      takeProfit: this.decimal(position.takeProfit, 'position.takeProfit'),
      unrealisedPnl: this.decimal(position.unrealisedPnl, 'position.unrealisedPnl'),
      openedAt: this.date(position.openedAt, 'position.openedAt'),
      commission: this.decimal(position.commission, 'position.commission'),
      swap: this.decimal(position.swap, 'position.swap'),
    };
  }

  private normalizeOrderState(order: BrokerOrderState): BrokerOrderState {
    return {
      ...order,
      providerOrderId: String(order.providerOrderId),
      instrument: String(order.instrument),
      requestedQuantity: this.decimal(order.requestedQuantity, 'order.requestedQuantity'),
      filledQuantity: this.decimal(order.filledQuantity, 'order.filledQuantity'),
      avgFillPrice:
        order.avgFillPrice == null
          ? order.avgFillPrice
          : this.decimal(order.avgFillPrice, 'order.avgFillPrice'),
      limitPrice:
        order.limitPrice == null
          ? order.limitPrice
          : this.decimal(order.limitPrice, 'order.limitPrice'),
      stopPrice:
        order.stopPrice == null
          ? order.stopPrice
          : this.decimal(order.stopPrice, 'order.stopPrice'),
      placedAt: order.placedAt ? this.date(order.placedAt, 'order.placedAt') : order.placedAt,
      updatedAt: order.updatedAt ? this.date(order.updatedAt, 'order.updatedAt') : order.updatedAt,
      raw: undefined,
    };
  }

  private normalizeClosedTrade(trade: BrokerClosedTrade): BrokerClosedTrade {
    return {
      ...trade,
      externalOrderId: String(trade.externalOrderId),
      instrument: String(trade.instrument),
      lotSize: this.decimal(trade.lotSize, 'trade.lotSize'),
      openPrice: this.decimal(trade.openPrice, 'trade.openPrice'),
      closePrice: this.decimal(trade.closePrice, 'trade.closePrice'),
      stopLoss: this.decimal(trade.stopLoss, 'trade.stopLoss'),
      takeProfit: this.decimal(trade.takeProfit, 'trade.takeProfit'),
      realisedPnl: this.decimal(trade.realisedPnl, 'trade.realisedPnl'),
      openedAt: this.date(trade.openedAt, 'trade.openedAt'),
      closedAt: this.date(trade.closedAt, 'trade.closedAt'),
      commission: this.decimal(trade.commission, 'trade.commission'),
      swap: this.decimal(trade.swap, 'trade.swap'),
    };
  }

  private assertAccountPayload(payload: AccountPayload): void {
    const identity = this.requireIdentity();
    if (String(payload.accountId) !== identity.accountLogin) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'MT5 account identity changed after connection',
        undefined,
        false,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
  }

  private modificationIdentity(modifications: BrokerOrderModification): string {
    return [
      modifications.newStopLoss ?? '-',
      modifications.newTakeProfit ?? '-',
      modifications.newTrailingStop ?? '-',
    ].join(':');
  }

  private decimal(value: unknown, field: string): string {
    const text = String(value ?? '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `MT5 bridge returned invalid decimal for ${field}`,
      );
    }
    return text;
  }

  private positiveDecimal(value: unknown, field: string): string {
    const text = this.decimal(value, field);
    if (Number(text) <= 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `${field} must be positive`,
        undefined,
        false,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
    return text;
  }

  private nonNegativeInteger(value: unknown, field: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `MT5 bridge returned invalid integer for ${field}`,
      );
    }
    return number;
  }

  private date(value: unknown, field: string): Date {
    const date = value instanceof Date ? new Date(value) : new Date(String(value ?? ''));
    if (!Number.isFinite(date.getTime())) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `MT5 bridge returned invalid timestamp for ${field}`,
      );
    }
    return date;
  }

  private spreadDecimal(bid: string, ask: string): string {
    const parse = (value: string) => {
      const [whole, fraction = ''] = value.split('.');
      return { whole, fraction };
    };
    const bidParts = parse(bid);
    const askParts = parse(ask);
    const scale = Math.max(bidParts.fraction.length, askParts.fraction.length);
    const factor = 10n ** BigInt(scale);
    const scaled = (parts: { whole: string; fraction: string }): bigint =>
      BigInt(parts.whole) * factor + BigInt((parts.fraction || '').padEnd(scale, '0') || '0');
    const diff = scaled(askParts) - scaled(bidParts);
    if (diff < 0n) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        'MT5 bridge returned ask below bid',
      );
    }
    if (scale === 0) return diff.toString();
    const digits = diff.toString().padStart(scale + 1, '0');
    return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }

  private plainDecimal(value: number): string {
    if (!Number.isFinite(value)) {
      throw new BrokerAdapterError(BrokerErrorCode.INVALID_REQUEST, 'Invalid MT5 numeric result');
    }
    return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') || '0';
  }
}
