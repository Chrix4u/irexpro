import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdapterMetadata,
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
import {
  isOandaOrderRejection,
  mapOandaError,
  OandaApiError,
  oandaOrderRejectReason,
} from './oanda.error-mapper';
import {
  FetchOandaTransport,
  OANDA_DEFAULT_DEMO_BASE_URL,
  OANDA_DEFAULT_LIVE_BASE_URL,
  OandaHttpMethod,
  OandaTransport,
} from './oanda.transport';
import { toCanonicalSymbol, toProviderSymbol } from './oanda.symbol-mapper';

// ─── v20 REST response shapes (decimals arrive as provider strings) ───────────

interface V3AccountsResponse {
  accounts?: Array<{ id: string; currency?: string }>;
}

interface V3AccountSummaryResponse {
  account?: {
    id: string;
    currency: string;
    balance: string;
    nav?: string;
    marginUsed: string;
    marginAvailable: string;
    marginCallMarginLevel?: string;
    openTradeCount?: number;
  };
}

interface V3Instrument {
  name: string;
  type: string;
  displayName: string;
  displayPrecision: number;
  minimumTradeSize: string;
  maximumTradeSize: string;
  tradeUnitsPrecision?: number;
  marginRate?: string;
}

interface V3InstrumentsResponse {
  instruments?: V3Instrument[];
}

interface V3Price {
  instrument: string;
  time: string;
  bids?: Array<{ price: string }>;
  asks?: Array<{ price: string }>;
  closeoutAsk?: string;
  closeoutBid?: string;
}

interface V3PricingResponse {
  prices?: V3Price[];
}

interface V3Candle {
  time: string;
  volume: number;
  complete: boolean;
  mid: { o: string; h: string; l: string; c: string };
}

interface V3CandlesResponse {
  candles?: V3Candle[];
}

interface V3OrderCreateResponse {
  orderCreateTransaction?: {
    id: string;
    type?: string;
    time?: string;
    instrument?: string;
    units?: string;
  };
  orderFillTransaction?: {
    id?: string;
    price?: string;
    units?: string;
    time?: string;
    tradeOpened?: { tradeID?: string; units?: string };
  };
}

interface V3OrderRequest {
  order: {
    type: 'MARKET' | 'LIMIT' | 'STOP';
    instrument: string;
    units: string;
    timeInForce: 'GTC' | 'DAY' | 'IOC' | 'FOK';
    price?: string;
    stopLossOnFill?: { price: string; timeInForce: 'GTC' };
    takeProfitOnFill?: { price: string; timeInForce: 'GTC' };
    clientExtensions?: { id: string };
  };
}

interface V3Trade {
  id: string;
  instrument: string;
  units: string;
  price: string;
  openTime: string;
  unrealizedPL?: string;
  financing?: string;
  stopLossOrder?: { price?: string };
  takeProfitOrder?: { price?: string };
  clientExtensions?: { id?: string };
}

interface V3OpenTradesResponse {
  trades?: V3Trade[];
}

interface V3ClosedTrade {
  id: string;
  instrument: string;
  units: string;
  price: string;
  realizedPL: string;
  financing?: string;
  openTime: string;
  closeTime: string;
  averageClosePrice?: string;
  stopLossOrder?: { price?: string };
  takeProfitOrder?: { price?: string };
}

interface V3ClosedTradesResponse {
  trades?: V3ClosedTrade[];
}

interface V3Order {
  id: string;
  instrument: string;
  units: string;
  state?: string;
  type?: string;
  price?: string;
  timeInForce?: string;
  createTime?: string;
  clientExtensions?: { id?: string };
}

interface V3OrdersListResponse {
  orders?: V3Order[];
}

interface V3SingleOrderResponse {
  order?: V3Order;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Log-privacy helper (Phase F): the broker account identifier never reaches
 * the logs in full — only the last 4 characters survive.
 */
function maskAccountIdForLog(value: string | null | undefined): string {
  if (!value || value.length < 4) return '•••';
  return `•••${String(value).slice(-4)}`;
}

/** Standard FX contract size in units per lot (OANDA CURRENCY instruments). */
const FX_CONTRACT_SIZE = '100000';
/** 5dp conversion precision for unit↔lot and spread computations. */
const CONVERSION_DECIMALS = 5;
const CONVERSION_SCALE = Math.pow(10, CONVERSION_DECIMALS);

/**
 * OandaAdapter — native OANDA v20 REST integration (Sprint 51 PR-7).
 *
 * STATUS: BETA — implemented + contract-tested, NOT live-verified (no
 * end-to-end order cycle against a real practice account yet).
 *
 * Environment routing: the adapter owns DEMO (api-fxpractice) vs LIVE
 * (api-fxtrade) base-URL selection per setMode(); the injectable transport
 * records which environment every request addressed.
 *
 * SECURITY INVARIANTS:
 * - The API token (DecryptedBrokerCredentials.apiKey) is held in-memory
 *   only, sent ONLY in the Authorization header, never logged, never
 *   returned in results, and redacted from every error message.
 * - All monetary/quantity values are decimal STRINGS (v20 itself returns
 *   decimals as strings — passed through with validation, never floats).
 * - The idempotencyKey travels as clientExtensions.id (provider dedup).
 * - Unknown provider states fail closed (UNKNOWN / throw — never guessed).
 */
@Injectable()
export class OandaAdapter implements IBrokerAdapter, AdapterMetadata {
  private readonly logger = new Logger(OandaAdapter.name);

  readonly brokerId = 'oanda';
  readonly brokerName = 'OANDA (v20 REST — BETA)';
  readonly supportsDemo = true;

  // ─── Directive §AL/§AM — operational metadata (informational only) ────────
  readonly providerApiVersion = 'v20';
  readonly adapterVersion = '1.0.0';
  /**
   * Conservative OPERATIONAL defaults for metadata/observability — OANDA
   * does not publish a single global rate limit and practice environments
   * vary. These are NOT enforced by this adapter version.
   */
  readonly rateLimitProfile = { requestsPerSecond: 20, burst: 100 };

  private readonly demoBaseUrl: string;
  private readonly liveBaseUrl: string;
  private readonly transport: OandaTransport;

  private mode: BrokerMode = BrokerMode.DEMO;
  private connected = false;
  private token: string | undefined;
  private accountId: string | undefined;

  constructor(@Optional() configService?: ConfigService, @Optional() transport?: OandaTransport) {
    this.demoBaseUrl =
      configService?.get<string>('OANDA_API_BASE_DEMO') ?? OANDA_DEFAULT_DEMO_BASE_URL;
    this.liveBaseUrl =
      configService?.get<string>('OANDA_API_BASE_LIVE') ?? OANDA_DEFAULT_LIVE_BASE_URL;
    this.transport = transport ?? new FetchOandaTransport();
  }

  setMode(mode: BrokerMode): void {
    this.mode = mode;
  }

  /** Environment base URL for the current mode — never crossed. */
  private get baseUrl(): string {
    return this.mode === BrokerMode.DEMO ? this.demoBaseUrl : this.liveBaseUrl;
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  async connect(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    const token = credentials.apiKey;
    if (!token || !credentials.accountId) {
      throw new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        'OANDA connect requires credentials.apiKey (personal access token) and credentials.accountId',
      );
    }
    try {
      // 1. Discover the accounts this token can reach and verify ours is there.
      const accounts = await this.request<V3AccountsResponse>(
        'GET',
        '/v3/accounts',
        token,
        undefined,
      );
      const accessible = accounts.accounts?.some((entry) => entry?.id === credentials.accountId);
      if (!accessible) {
        throw new BrokerAdapterError(
          BrokerErrorCode.ACCOUNT_NOT_FOUND,
          `OANDA account "${credentials.accountId}" is not accessible for this token`,
          'account id absent from GET /v3/accounts response',
          false,
        );
      }

      // 2. Read the summary to confirm the account and capture its currency.
      const summary = await this.fetchSummary(credentials.accountId, token);

      this.token = token; // in-memory only — never logged, never persisted
      this.accountId = credentials.accountId;
      this.connected = true;

      this.logger.log(
        `OANDA v20 connected: account=${maskAccountIdForLog(credentials.accountId)} mode=${this.mode} ` +
          `currency=${summary.account.currency}`,
      );
      return {
        success: true,
        accountId: credentials.accountId,
        accountType: this.mode,
        currency: summary.account.currency,
        serverTime: new Date(),
      };
    } catch (err) {
      this.connected = false;
      this.token = undefined;
      this.accountId = undefined;
      throw this.mapError(err);
    }
  }

  async disconnect(): Promise<void> {
    // v20 REST is stateless — "disconnecting" clears the in-memory session
    // (token + account id). No server-side session exists to tear down.
    const hadAccount = this.accountId !== undefined;
    this.connected = false;
    this.token = undefined;
    this.accountId = undefined;
    if (hadAccount) this.logger.log('OANDA v20 disconnected (in-memory session cleared)');
  }

  async testConnection(
    credentials: DecryptedBrokerCredentials,
  ): Promise<BrokerConnectionTestResult> {
    try {
      if (!credentials.apiKey) {
        throw new BrokerAdapterError(
          BrokerErrorCode.AUTHENTICATION_FAILED,
          'OANDA testConnection requires credentials.apiKey',
        );
      }
      const accounts = await this.request<V3AccountsResponse>(
        'GET',
        '/v3/accounts',
        credentials.apiKey,
        undefined,
      );
      const found = accounts.accounts?.find((entry) => entry?.id === credentials.accountId);
      if (!found) {
        return {
          success: false,
          errorCode: BrokerErrorCode.ACCOUNT_NOT_FOUND,
          errorMessage: `OANDA account "${credentials.accountId}" is not accessible for this token`,
        };
      }
      return {
        success: true,
        accountId: found.id,
        accountType: this.mode,
        currency: found.currency,
      };
    } catch (err) {
      const mapped = this.mapError(err);
      return { success: false, errorCode: mapped.code, errorMessage: mapped.message };
    }
  }

  isConnected(): boolean {
    return this.connected && this.token !== undefined && this.accountId !== undefined;
  }

  // ─── Account state ────────────────────────────────────────────────────────

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    const { accountId, token } = this.requireConnection();
    try {
      const response = await this.fetchSummary(accountId, token);
      const account = response.account;
      return {
        accountId: String(account.id ?? accountId),
        currency: account.currency,
        // OANDA v20 does not report account leverage: margin is marginRate-
        // based per instrument. leverage=1 is the CONSERVATIVE floor used by
        // downstream risk metadata — margin capacity checks must rely on
        // getRequiredMargin() (marginRate-based), never on 1/leverage math.
        leverage: 1,
        balance: this.requiredDecimal(account.balance, 'account.balance'),
        equity: this.requiredDecimal(account.nav ?? account.balance, 'account.nav'),
        margin: this.requiredDecimal(account.marginUsed, 'account.marginUsed'),
        freeMargin: this.requiredDecimal(account.marginAvailable, 'account.marginAvailable'),
        marginLevel: this.optionalDecimal(account.marginCallMarginLevel),
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    const { accountId, token } = this.requireConnection();
    try {
      const response = await this.fetchSummary(accountId, token);
      const account = response.account;
      return {
        balance: this.requiredDecimal(account.balance, 'account.balance'),
        equity: this.requiredDecimal(account.nav ?? account.balance, 'account.nav'),
        currency: account.currency,
        timestamp: new Date(),
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    const { accountId, token } = this.requireConnection();
    try {
      const response = await this.request<V3OpenTradesResponse>(
        'GET',
        `/v3/accounts/${this.enc(accountId)}/openTrades`,
        token,
        undefined,
      );
      const trades = response.trades ?? [];
      if (trades.length === 0) return [];

      const contractSizes = await this.fetchContractSizes(token);
      const priceByInstrument = await this.fetchPrices(
        token,
        trades.map((trade) => trade.instrument),
      );
      return trades.map((trade) => this.mapPosition(trade, contractSizes, priceByInstrument));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    const positions = await this.getOpenPositions();
    return positions.find((position) => position.externalOrderId === externalOrderId) ?? null;
  }

  /**
   * OANDA v20 exposes no direct margin-calculation endpoint. APPROXIMATION
   * (documented): requiredMargin = units × price × instrument marginRate,
   * using the direction-correct execution price (BUY→ask, SELL→bid).
   * Returns null whenever the instrument or a price is unavailable — the
   * Risk Engine fails closed on null.
   */
  async getRequiredMargin(params: RequiredMarginParams): Promise<string | null> {
    const { token } = this.requireConnection();
    try {
      const providerInstrument = toProviderSymbol(params.instrument);
      const instrument = await this.findInstrument(providerInstrument, token);
      if (!instrument || instrument.marginRate === undefined) return null;

      const price = await this.getCurrentPrice(params.instrument);
      const units = this.toUnits(
        params.lotSize,
        this.contractSizeForInstrument(instrument),
        params.direction,
      );
      const numericUnits = Math.abs(parseFloat(units));
      const rate = parseFloat(instrument.marginRate);
      const executionPrice = params.direction === 'BUY' ? price.ask : price.bid;
      const numericPrice = parseFloat(executionPrice);
      if (
        !Number.isFinite(numericUnits) ||
        !Number.isFinite(rate) ||
        !Number.isFinite(numericPrice) ||
        numericUnits <= 0 ||
        rate < 0 ||
        numericPrice <= 0
      ) {
        return null;
      }
      const margin = numericUnits * numericPrice * rate;
      if (!Number.isFinite(margin) || margin < 0) return null;
      return (Math.round(margin * 100) / 100).toFixed(2);
    } catch {
      // Fail-closed: any failure (pricing unavailable, instrument unknown)
      // yields null — never a fabricated margin.
      return null;
    }
  }

  // ─── Market data ──────────────────────────────────────────────────────────

  async getInstrumentList(): Promise<BrokerInstrument[]> {
    const { accountId, token } = this.requireConnection();
    try {
      const response = await this.request<V3InstrumentsResponse>(
        'GET',
        `/v3/instruments?accountID=${this.enc(accountId)}`,
        token,
        undefined,
      );
      return (response.instruments ?? []).map((instrument) => {
        const contractSize = this.contractSizeForInstrument(instrument);
        // FX lot conversion: OANDA reports sizes in UNITS; our lots are
        // standard lots. Non-CURRENCY instruments (metals/CFDs) carry
        // contractSize '1' — units map 1:1 to lots (directive-approved
        // approximation, documented honestly).
        const lotStepUnits =
          instrument.tradeUnitsPrecision !== undefined && instrument.tradeUnitsPrecision >= 0
            ? Math.pow(10, -instrument.tradeUnitsPrecision)
            : parseFloat(instrument.minimumTradeSize);
        return {
          symbol: toCanonicalSymbol(instrument.name),
          description: instrument.displayName ?? instrument.name,
          digits: typeof instrument.displayPrecision === 'number' ? instrument.displayPrecision : 5,
          minLot: this.unitsToLots(instrument.minimumTradeSize, contractSize),
          maxLot: this.unitsToLots(instrument.maximumTradeSize, contractSize),
          // OANDA does not expose a separate step field: the minimum
          // tradeable increment (units precision) is the honest step.
          lotStep: this.unitsToLots(String(lotStepUnits), contractSize),
          contractSize,
        };
      });
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getCurrentPrice(instrument: string): Promise<BrokerPrice> {
    const { accountId, token } = this.requireConnection();
    const providerInstrument = toProviderSymbol(instrument);
    try {
      const response = await this.request<V3PricingResponse>(
        'GET',
        `/v3/accounts/${this.enc(accountId)}/pricing?instruments=${this.enc(providerInstrument)}`,
        token,
        undefined,
      );
      const price = response.prices?.find((entry) => entry.instrument === providerInstrument);
      if (!price) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_INSTRUMENT,
          `OANDA pricing returned no quote for instrument "${providerInstrument}"`,
        );
      }
      const bid = this.requiredDecimal(price.bids?.[price.bids.length - 1]?.price, 'pricing.bid');
      const ask = this.requiredDecimal(price.asks?.[price.asks.length - 1]?.price, 'pricing.ask');
      return {
        instrument: toCanonicalSymbol(price.instrument),
        bid,
        ask,
        spread: this.spread(ask, bid),
        timestamp: this.parseDate(price.time, 'pricing.time'),
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getOHLCV(instrument: string, timeframe: string, count: number): Promise<OHLCV[]> {
    const { token } = this.requireConnection();
    if (count < 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `OANDA getOHLCV requires a non-negative candle count (got ${count})`,
      );
    }
    if (count === 0) return [];
    const providerInstrument = toProviderSymbol(instrument);
    const granularity = this.mapGranularity(timeframe);
    try {
      const response = await this.request<V3CandlesResponse>(
        'GET',
        `/v3/instruments/${this.enc(providerInstrument)}/candles` +
          `?granularity=${this.enc(granularity)}&count=${count}&price=M`,
        token,
        undefined,
      );
      return (response.candles ?? []).map((candle) => ({
        timestamp: this.parseDate(candle.time, 'candle.time'),
        open: this.requiredDecimal(candle.mid.o, 'candle.mid.o'),
        high: this.requiredDecimal(candle.mid.h, 'candle.mid.h'),
        low: this.requiredDecimal(candle.mid.l, 'candle.mid.l'),
        close: this.requiredDecimal(candle.mid.c, 'candle.mid.c'),
        volume: this.requiredDecimal(candle.volume, 'candle.volume'),
      }));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── Order management ─────────────────────────────────────────────────────

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const { accountId, token } = this.requireConnection();
    try {
      const kind = order.orderKind ?? 'MARKET';
      // Fail-closed order-kind dispatch: never silently downgrade. OANDA
      // v20 order placement covers MARKET/LIMIT/STOP; STOP_LIMIT is NOT
      // mapped by this adapter and is rejected loudly.
      if (kind === 'STOP_LIMIT') {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_ORDER_TYPE,
          'OANDA v20 adapter does not map STOP_LIMIT orders (fail-closed — never silently downgraded to MARKET/STOP)',
        );
      }
      if (kind !== 'MARKET' && kind !== 'LIMIT' && kind !== 'STOP') {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_ORDER_TYPE,
          `Unsupported order kind: ${kind}`,
        );
      }

      // Price validation BEFORE any request (fail-fast, MT-adapter style).
      if (kind === 'LIMIT' && !this.isPositiveDecimal(order.limitPrice)) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_PRICE,
          'LIMIT order requires a positive decimal limitPrice',
        );
      }
      if (kind === 'STOP' && !this.isPositiveDecimal(order.stopPrice)) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_PRICE,
          'STOP order requires a positive decimal stopPrice',
        );
      }
      if (!this.isPositiveDecimal(order.lotSize)) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_LOT_SIZE,
          `Invalid lotSize "${order.lotSize}" — must be a positive decimal string`,
        );
      }

      const providerInstrument = toProviderSymbol(order.instrument);
      const contractSize = await this.contractSizeFor(providerInstrument, token);
      // Units conversion: lots × contractSize → signed integer units
      // (BUY positive, SELL negative).
      const units = this.toUnits(order.lotSize, contractSize, order.direction);

      const body: V3OrderRequest = {
        order: {
          type: kind,
          instrument: providerInstrument,
          units,
          timeInForce: order.timeInForce ?? 'GTC',
          // Idempotency passthrough (Directive §AN #6): the caller's
          // idempotencyKey is the provider-side dedup surface.
          clientExtensions: { id: order.idempotencyKey },
        },
      };
      if (kind === 'LIMIT') {
        body.order.price = this.requiredDecimal(order.limitPrice, 'limitPrice');
      }
      if (kind === 'STOP') {
        body.order.price = this.requiredDecimal(order.stopPrice, 'stopPrice');
      }
      const stopLoss = this.dependentOrderPrice(order.stopLoss);
      if (stopLoss !== null) {
        body.order.stopLossOnFill = { price: stopLoss, timeInForce: 'GTC' };
      }
      const takeProfit = this.dependentOrderPrice(order.takeProfit);
      if (takeProfit !== null) {
        body.order.takeProfitOnFill = { price: takeProfit, timeInForce: 'GTC' };
      }

      this.logger.log(
        `OANDA order submitted: instrument=${providerInstrument} units=${units} ` +
          `kind=${kind} tif=${body.order.timeInForce} [idempotency clientExtensions.id present]`,
      );

      const response = await this.request<V3OrderCreateResponse>(
        'POST',
        `/v3/accounts/${this.enc(accountId)}/orders`,
        token,
        body,
      );
      return this.mapOrderCreateResponse(response, contractSize);
    } catch (err) {
      if (err instanceof OandaApiError && err.status === 400 && isOandaOrderRejection(err.body)) {
        // Provider refused the order (definitive refusal, e.g.
        // MARGIN_NOT_SUFFICIENT) — surfaced as an honest REJECTED result,
        // never a throw-that-looks-like-an-outage.
        const reason = oandaOrderRejectReason(err.body) ?? 'unknown rejection reason';
        return {
          success: false,
          status: 'REJECTED',
          brokerMessage: `OANDA order rejected: ${reason}`,
          rawResponse: err.body,
        };
      }
      throw this.mapError(err);
    }
  }

  /**
   * SL/TP modification on the open TRADE: replaces the trade's dependent
   * orders via PUT /v3/accounts/{id}/trades/{tradeSpecifier}/orders.
   * externalOrderId here is the TRADE id. Trailing-stop-only modification
   * is NOT mapped by this adapter and fails closed (INVALID_REQUEST).
   */
  async modifyOrder(
    externalOrderId: string,
    modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult> {
    const { accountId, token } = this.requireConnection();
    if (modifications.newTrailingStop !== undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        'OANDA v20 adapter does not map trailing-stop modifications (fail-closed — use stopLoss/takeProfit only)',
      );
    }
    try {
      const body: {
        stopLoss?: { price: string; timeInForce: 'GTC' };
        takeProfit?: { price: string; timeInForce: 'GTC' };
      } = {};
      if (modifications.newStopLoss !== undefined) {
        const price = this.dependentOrderPrice(modifications.newStopLoss);
        if (price !== null) body.stopLoss = { price, timeInForce: 'GTC' };
      }
      if (modifications.newTakeProfit !== undefined) {
        const price = this.dependentOrderPrice(modifications.newTakeProfit);
        if (price !== null) body.takeProfit = { price, timeInForce: 'GTC' };
      }
      if (body.stopLoss === undefined && body.takeProfit === undefined) {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_REQUEST,
          'OANDA modifyOrder requires newStopLoss and/or newTakeProfit',
        );
      }
      await this.request<Record<string, unknown>>(
        'PUT',
        `/v3/accounts/${this.enc(accountId)}/trades/${this.enc(externalOrderId)}/orders`,
        token,
        body,
      );
      return {
        success: true,
        externalOrderId,
        status: 'FILLED',
        brokerMessage: 'OANDA trade dependent orders updated',
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    const { accountId, token } = this.requireConnection();
    try {
      const trade = await this.findOpenTrade(externalOrderId);
      if (!trade) {
        throw new BrokerAdapterError(
          BrokerErrorCode.POSITION_NOT_FOUND,
          `OANDA trade "${externalOrderId}" is not an open trade`,
        );
      }
      const contractSize = await this.contractSizeFor(trade.instrument, token);
      // v20 close: {units: 'ALL'} for full close, or the positive number of
      // units to close for a partial close (same direction as the trade).
      const body: { units: string } = lotSize
        ? { units: this.absoluteUnits(lotSize, contractSize) }
        : { units: 'ALL' };

      const response = await this.request<V3OrderCreateResponse>(
        'PUT',
        `/v3/accounts/${this.enc(accountId)}/trades/${this.enc(externalOrderId)}/close`,
        token,
        body,
      );
      const fill = response.orderFillTransaction;
      const filledUnits = fill?.units !== undefined ? Math.abs(parseFloat(fill.units)) : 0;
      return {
        success: true,
        externalOrderId,
        filledPrice: fill?.price !== undefined ? this.optionalDecimal(fill.price) : undefined,
        filledQuantity:
          fill?.units !== undefined
            ? this.unitsToLots(String(filledUnits), contractSize)
            : undefined,
        filledAt:
          fill?.time !== undefined ? this.parseDate(fill.time, 'close.fillTime') : undefined,
        status: 'FILLED',
        brokerMessage: 'OANDA trade closed',
        rawResponse: response,
      };
    } catch (err) {
      if (err instanceof OandaApiError && err.status === 400) {
        const reject = err.body?.orderFillRejectTransaction as { reason?: string } | undefined;
        if (reject?.reason !== undefined) {
          return {
            success: false,
            externalOrderId,
            status: 'REJECTED',
            brokerMessage: `OANDA close rejected: ${reject.reason}`,
            rawResponse: err.body,
          };
        }
      }
      throw this.mapError(err);
    }
  }

  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    const positions = await this.getOpenPositions();
    let closedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    await Promise.allSettled(
      positions.map(async (position) => {
        try {
          const result = await this.closeOrder(position.externalOrderId);
          if (result.success) {
            closedCount++;
          } else {
            failedCount++;
            errors.push(`${position.externalOrderId}: ${result.brokerMessage ?? 'failed'}`);
          }
        } catch (err) {
          failedCount++;
          errors.push(`${position.externalOrderId}: ${(err as Error).message}`);
        }
      }),
    );
    this.logger.log(
      `OANDA closeAllOrders: closed=${closedCount} failed=${failedCount} of ${positions.length}`,
    );
    return { closedCount, failedCount, errors };
  }

  // ─── Trade history ────────────────────────────────────────────────────────

  async getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]> {
    const { accountId, token } = this.requireConnection();
    try {
      const query =
        'state=CLOSED' +
        `&from=${this.enc(from.toISOString())}` +
        `&to=${this.enc(to.toISOString())}`;
      const response = await this.request<V3ClosedTradesResponse>(
        'GET',
        `/v3/accounts/${this.enc(accountId)}/trades?${query}`,
        token,
        undefined,
      );
      const trades = response.trades ?? [];
      if (trades.length === 0) return [];
      const contractSizes = await this.fetchContractSizes(token);
      return trades.map((trade) => this.mapClosedTrade(trade, contractSizes));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── Provider order state (reconciliation read surface) ──────────────────

  /**
   * Working orders: queries BOTH state=PENDING and state=TRIGGERED (a
   * triggered stop that became a market order is still working) and merges
   * the two sets (dedup by order id).
   */
  async listOrders(): Promise<BrokerOrderState[]> {
    const { accountId, token } = this.requireConnection();
    try {
      const pending = await this.request<V3OrdersListResponse>(
        'GET',
        `/v3/accounts/${this.enc(accountId)}/orders?state=PENDING`,
        token,
        undefined,
      );
      const triggered = await this.request<V3OrdersListResponse>(
        'GET',
        `/v3/accounts/${this.enc(accountId)}/orders?state=TRIGGERED`,
        token,
        undefined,
      );
      const orders = [...(pending.orders ?? []), ...(triggered.orders ?? [])];
      const seen = new Set<string>();
      const unique = orders.filter((order) => {
        const id = String(order.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (unique.length === 0) return [];
      const contractSizes = await this.fetchContractSizes(token);
      return unique.map((order) => this.mapOrderState(order, contractSizes));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    const { accountId, token } = this.requireConnection();
    try {
      const response = await this.request<V3SingleOrderResponse>(
        'GET',
        `/v3/accounts/${this.enc(accountId)}/orders/${this.enc(providerOrderId)}`,
        token,
        undefined,
      );
      if (!response.order) {
        // A 200 response without an order object is malformed — NEVER
        // interpreted as "not found" (null is reserved for the provider's
        // legitimate 404-style answer, Directive §AN #7).
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_REQUEST,
          'OANDA single-order response missing the order object — outcome cannot be recorded',
        );
      }
      const contractSizes = await this.fetchContractSizes(token);
      return this.mapOrderState(response.order, contractSizes);
    } catch (err) {
      const mapped = this.mapError(err);
      // null is ONLY allowed for a legitimate provider not-found — never
      // as an error fallback (Directive §AN #7).
      if (mapped.code === BrokerErrorCode.POSITION_NOT_FOUND) return null;
      throw mapped;
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private requireConnection(): { accountId: string; token: string } {
    if (!this.connected || this.token === undefined || this.accountId === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.NOT_CONNECTED,
        'OANDA adapter is not connected. Call connect() first.',
        undefined,
        false,
      );
    }
    return { accountId: this.accountId, token: this.token };
  }

  private async fetchSummary(
    accountId: string,
    token: string,
  ): Promise<{ account: NonNullable<V3AccountSummaryResponse['account']> }> {
    const response = await this.request<V3AccountSummaryResponse>(
      'GET',
      `/v3/accounts/${this.enc(accountId)}/summary`,
      token,
      undefined,
    );
    if (!response.account || !response.account.id) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        'OANDA summary response is missing the account object',
      );
    }
    return { account: response.account };
  }

  private async request<T>(
    method: OandaHttpMethod,
    path: string,
    token: string,
    body: unknown,
  ): Promise<T> {
    // The ONLY channel the token ever travels through — request headers.
    return this.transport.request<T>(method, this.baseUrl, path, this.authHeaders(token), body);
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Datetime-Format': 'RFC3339',
    };
  }

  private async fetchContractSizes(token: string): Promise<Map<string, string>> {
    const { accountId } = this.requireConnection();
    const response = await this.request<V3InstrumentsResponse>(
      'GET',
      `/v3/instruments?accountID=${this.enc(accountId)}`,
      token,
      undefined,
    );
    const map = new Map<string, string>();
    for (const instrument of response.instruments ?? []) {
      map.set(instrument.name, this.contractSizeForInstrument(instrument));
    }
    return map;
  }

  private async contractSizeFor(providerInstrument: string, token: string): Promise<string> {
    const instrument = await this.findInstrument(providerInstrument, token);
    if (!instrument) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `OANDA instrument "${providerInstrument}" not present in /v3/instruments — cannot convert lots/units honestly`,
      );
    }
    return this.contractSizeForInstrument(instrument);
  }

  private async findInstrument(
    providerInstrument: string,
    token: string,
  ): Promise<V3Instrument | null> {
    const { accountId } = this.requireConnection();
    const response = await this.request<V3InstrumentsResponse>(
      'GET',
      `/v3/instruments?accountID=${this.enc(accountId)}`,
      token,
      undefined,
    );
    return (
      response.instruments?.find((instrument) => instrument.name === providerInstrument) ?? null
    );
  }

  private async fetchPrices(
    token: string,
    providerInstruments: string[],
  ): Promise<Map<string, { bid: string; ask: string }>> {
    const { accountId } = this.requireConnection();
    const unique = Array.from(new Set(providerInstruments));
    const response = await this.request<V3PricingResponse>(
      'GET',
      `/v3/accounts/${this.enc(accountId)}/pricing?instruments=${unique.map((i) => this.enc(i)).join(',')}`,
      token,
      undefined,
    );
    const map = new Map<string, { bid: string; ask: string }>();
    for (const price of response.prices ?? []) {
      const bid = this.optionalDecimal(price.bids?.[price.bids.length - 1]?.price);
      const ask = this.optionalDecimal(price.asks?.[price.asks.length - 1]?.price);
      map.set(price.instrument, { bid, ask });
    }
    return map;
  }

  private async findOpenTrade(tradeSpecifier: string): Promise<V3Trade | null> {
    const { accountId, token } = this.requireConnection();
    const response = await this.request<V3OpenTradesResponse>(
      'GET',
      `/v3/accounts/${this.enc(accountId)}/openTrades`,
      token,
      undefined,
    );
    return response.trades?.find((trade) => String(trade.id) === tradeSpecifier) ?? null;
  }

  private mapPosition(
    trade: V3Trade,
    contractSizes: Map<string, string>,
    priceByInstrument: Map<string, { bid: string; ask: string }>,
  ): BrokerPosition {
    const contractSize = contractSizes.get(trade.instrument);
    if (contractSize === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `OANDA trade instrument "${trade.instrument}" not present in /v3/instruments — cannot convert units to lots honestly`,
      );
    }
    const quote = priceByInstrument.get(trade.instrument);
    if (quote === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.PROVIDER_UNAVAILABLE,
        `OANDA pricing unavailable for instrument "${trade.instrument}" — refusing to fabricate currentPrice`,
        undefined,
        true,
      );
    }
    const units = parseFloat(trade.units);
    const direction: 'BUY' | 'SELL' = units >= 0 ? 'BUY' : 'SELL';
    // Realizable exit price for the position's direction (BUY→bid, SELL→ask).
    const currentPrice = direction === 'BUY' ? quote.bid : quote.ask;
    return {
      externalOrderId: String(trade.id),
      instrument: toCanonicalSymbol(trade.instrument),
      direction,
      lotSize: this.unitsToLots(trade.units, contractSize),
      openPrice: this.requiredDecimal(trade.price, 'trade.price'),
      currentPrice,
      stopLoss: this.optionalDecimal(trade.stopLossOrder?.price),
      takeProfit: this.optionalDecimal(trade.takeProfitOrder?.price),
      unrealisedPnl: this.requiredDecimal(trade.unrealizedPL, 'trade.unrealizedPL'),
      openedAt: this.parseDate(trade.openTime, 'trade.openTime'),
      // OANDA has no per-trade commission: costs are all-in in the spread.
      commission: '0',
      // Financing (swap) may legitimately be absent before the first
      // financing application — '0' is the honest value then.
      swap: this.optionalDecimal(trade.financing),
    };
  }

  private mapClosedTrade(
    trade: V3ClosedTrade,
    contractSizes: Map<string, string>,
  ): BrokerClosedTrade {
    const contractSize = contractSizes.get(trade.instrument);
    if (contractSize === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `OANDA closed-trade instrument "${trade.instrument}" not present in /v3/instruments — cannot convert units to lots honestly`,
      );
    }
    const units = parseFloat(trade.units);
    // Close reason: OANDA closed trades do not carry a closing-transaction
    // field — SL/TP dependent-order presence identifies broker-closed
    // trades; everything else is indeterminate → UNKNOWN (never guessed).
    const closeReason: BrokerClosedTrade['closeReason'] =
      trade.stopLossOrder !== undefined
        ? 'SL'
        : trade.takeProfitOrder !== undefined
          ? 'TP'
          : 'UNKNOWN';
    return {
      externalOrderId: String(trade.id),
      instrument: toCanonicalSymbol(trade.instrument),
      direction: units >= 0 ? 'BUY' : 'SELL',
      lotSize: this.unitsToLots(trade.units, contractSize),
      openPrice: this.requiredDecimal(trade.price, 'trade.price'),
      // averageClosePrice may be absent for edge-case closes — '0' with
      // this documentation (same convention as the MT adapter's deal rows).
      closePrice: this.optionalDecimal(trade.averageClosePrice),
      stopLoss: this.optionalDecimal(trade.stopLossOrder?.price),
      takeProfit: this.optionalDecimal(trade.takeProfitOrder?.price),
      realisedPnl: this.requiredDecimal(trade.realizedPL, 'trade.realizedPL'),
      openedAt: this.parseDate(trade.openTime, 'trade.openTime'),
      closedAt: this.parseDate(trade.closeTime, 'trade.closeTime'),
      commission: '0',
      swap: this.optionalDecimal(trade.financing),
      closeReason,
    };
  }

  private mapOrderCreateResponse(
    response: V3OrderCreateResponse,
    contractSize: string,
  ): BrokerOrderResult {
    const create = response.orderCreateTransaction;
    if (!create?.id) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        'OANDA order response missing orderCreateTransaction.id — outcome cannot be recorded',
      );
    }
    const fill = response.orderFillTransaction;
    if (fill) {
      // Filled at market: the fill's opened trade id is the position handle
      // for subsequent modify/close operations.
      return {
        success: true,
        externalOrderId: String(fill.tradeOpened?.tradeID ?? create.id),
        filledPrice: fill.price !== undefined ? this.optionalDecimal(fill.price) : undefined,
        filledQuantity:
          fill.units !== undefined ? this.unitsToLots(fill.units, contractSize) : undefined,
        filledAt: fill.time !== undefined ? this.parseDate(fill.time, 'orderFill.time') : undefined,
        status: 'FILLED',
        brokerMessage: 'OANDA order filled',
        rawResponse: response,
      };
    }
    // Accepted and resting at the provider (LIMIT/STOP) — NOT filled.
    return {
      success: true,
      externalOrderId: String(create.id),
      status: 'PENDING',
      brokerMessage: 'OANDA order accepted (working)',
      rawResponse: response,
    };
  }

  private mapOrderState(order: V3Order, contractSizes: Map<string, string>): BrokerOrderState {
    const contractSize = contractSizes.get(order.instrument);
    if (contractSize === undefined) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        `OANDA order instrument "${order.instrument}" not present in /v3/instruments — cannot convert units to lots honestly`,
      );
    }
    const units = parseFloat(order.units);
    const direction: 'BUY' | 'SELL' = units >= 0 ? 'BUY' : 'SELL';
    const state = this.mapOrderStateStatus(String(order.state ?? ''));
    const type = String(order.type ?? '');
    const orderKind: BrokerOrderState['orderKind'] =
      type === 'MARKET' || type === 'LIMIT' || type === 'STOP'
        ? (type as 'MARKET' | 'LIMIT' | 'STOP')
        : null;
    // OANDA pending-order payloads carry no partial-fill quantity field;
    // a terminal FILLED order reports its full requested units as filled.
    // Everything else is conservatively '0' (directive-strict mapping).
    const filledQuantity =
      state === 'FILLED' ? this.unitsToLots(order.units, contractSize) : '0.00000';
    return {
      providerOrderId: String(order.id),
      clientOrderId:
        order.clientExtensions?.id !== undefined ? String(order.clientExtensions.id) : null,
      status: state,
      instrument: toCanonicalSymbol(order.instrument),
      direction,
      requestedQuantity: this.unitsToLots(order.units, contractSize),
      filledQuantity,
      avgFillPrice: state === 'FILLED' ? this.validDecimalOrNull(order.price) : null,
      orderKind,
      limitPrice: type === 'LIMIT' ? this.validDecimalOrNull(order.price) : null,
      stopPrice: type === 'STOP' ? this.validDecimalOrNull(order.price) : null,
      timeInForce: order.timeInForce ?? null,
      placedAt:
        order.createTime !== undefined
          ? this.parseDate(order.createTime, 'order.createTime')
          : null,
      updatedAt: null,
      raw: order,
    };
  }

  /**
   * OANDA order-state matrix (directive-strict, fail-closed):
   * PENDING/TRIGGERED → WORKING; FILLED → FILLED; CANCELLED → CANCELLED;
   * anything else → UNKNOWN (reconciliation must not guess).
   */
  private mapOrderStateStatus(state: string): BrokerOrderState['status'] {
    switch (state) {
      case 'PENDING':
      case 'TRIGGERED':
        return 'WORKING';
      case 'FILLED':
        return 'FILLED';
      case 'CANCELLED':
        return 'CANCELLED';
      default:
        return 'UNKNOWN';
    }
  }

  private mapGranularity(timeframe: string): string {
    const map: Record<string, string> = {
      M1: 'M1',
      M5: 'M5',
      M15: 'M15',
      M30: 'M30',
      H1: 'H1',
      H4: 'H4',
      D1: 'D',
      W1: 'W',
      MN1: 'M',
    };
    // Unknown timeframes pass through — the provider rejects invalid
    // granularities with a mapped 400 (INVALID_REQUEST), never a guess.
    return map[timeframe] ?? timeframe;
  }

  private mapError(err: unknown): BrokerAdapterError {
    return mapOandaError(err, this.token);
  }

  private enc(value: string): string {
    return encodeURIComponent(value);
  }

  private contractSizeForInstrument(instrument: V3Instrument): string {
    // FX (type CURRENCY) trades standard 100000-unit lots. Metals/CFDs are
    // approximated with contractSize '1' (units == lots) — a documented,
    // directive-approved approximation for BETA.
    return instrument.type === 'CURRENCY' ? FX_CONTRACT_SIZE : '1';
  }

  /** Positive decimal units for a partial close (no direction sign). */
  private absoluteUnits(lotSize: string, contractSize: string): string {
    const units = this.toUnits(lotSize, contractSize, 'BUY');
    return String(Math.abs(parseFloat(units)));
  }

  /** lots × contractSize → signed integer units string (BUY +, SELL −). */
  private toUnits(lotSize: string, contractSize: string, direction: 'BUY' | 'SELL'): string {
    const lots = parseFloat(lotSize);
    const size = parseFloat(contractSize);
    if (!Number.isFinite(lots) || !Number.isFinite(size) || lots <= 0 || size <= 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_LOT_SIZE,
        `Invalid lotSize "${lotSize}" / contractSize "${contractSize}" — cannot convert to units`,
      );
    }
    const units = Math.round(lots * size);
    if (units <= 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_LOT_SIZE,
        `lotSize "${lotSize}" converts to ${units} units (too small for the instrument)`,
      );
    }
    return String(direction === 'BUY' ? units : -units);
  }

  /** |units| ÷ contractSize → lots decimal string (5dp). */
  private unitsToLots(units: string | number, contractSize: string): string {
    const numericUnits = Math.abs(typeof units === 'number' ? units : parseFloat(units));
    const size = parseFloat(contractSize);
    if (!Number.isFinite(numericUnits) || !Number.isFinite(size) || size <= 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `Cannot convert units "${String(units)}" / contractSize "${contractSize}" to lots`,
      );
    }
    return (Math.round((numericUnits / size) * CONVERSION_SCALE) / CONVERSION_SCALE).toFixed(
      CONVERSION_DECIMALS,
    );
  }

  private spread(ask: string, bid: string): string {
    const numeric = parseFloat(ask) - parseFloat(bid);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `OANDA pricing produced a malformed spread (ask=${ask}, bid=${bid})`,
      );
    }
    return (Math.round(numeric * CONVERSION_SCALE) / CONVERSION_SCALE).toFixed(CONVERSION_DECIMALS);
  }

  /** Required decimal field — throws (fail-closed) on malformed/missing. */
  private requiredDecimal(value: string | number | undefined | null, field: string): string {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (!DECIMAL_PATTERN.test(text)) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `OANDA returned malformed ${field} ("${text}") — refusing to fabricate a value`,
      );
    }
    return text;
  }

  /** Optional decimal field — '0' when absent/malformed (repo convention). */
  private optionalDecimal(value: string | number | undefined | null): string {
    const text = value === undefined || value === null ? '' : String(value).trim();
    return DECIMAL_PATTERN.test(text) ? text : '0';
  }

  private validDecimalOrNull(value: string | undefined): string | null {
    if (value === undefined) return null;
    return DECIMAL_PATTERN.test(value.trim()) ? value : null;
  }

  private isPositiveDecimal(value: string | undefined): boolean {
    if (value === undefined) return false;
    if (!DECIMAL_PATTERN.test(value.trim())) return false;
    return parseFloat(value) > 0;
  }

  /** Dependent-order price: null when the SL/TP is unset ('0'/empty). */
  private dependentOrderPrice(value: string | undefined): string | null {
    if (value === undefined) return null;
    const text = value.trim();
    if (text === '' || text === '0' || text === '0.0' || text === '0.00') return null;
    if (!DECIMAL_PATTERN.test(text)) return null;
    return text;
  }

  private parseDate(value: string | undefined, field: string): Date {
    const date = value !== undefined && value.length > 0 ? new Date(value) : new Date(NaN);
    if (Number.isNaN(date.getTime())) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_REQUEST,
        `OANDA returned malformed ${field} timestamp ("${String(value)}")`,
      );
    }
    return date;
  }
}
