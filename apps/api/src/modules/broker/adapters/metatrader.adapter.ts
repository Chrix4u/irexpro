import { Injectable, Logger } from '@nestjs/common';
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
} from '../interfaces/broker-adapter.interface';
import type { OrderCapabilityDeclaration } from '../interfaces/order-capability';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import {
  ProviderDispatchCertainty,
  withDefaultCertainty,
} from '../interfaces/provider-dispatch-certainty';
import { MetaApiClientService } from '../services/metaapi-client.service';
import { redactString } from '../../../common/utils/redact-sensitive.util';

/** MetaAPI stringCode for a successfully executed trade */
const MT_SUCCESS_CODE = 'TRADE_RETCODE_DONE';

/** MetaApi numeric retcode for a terminal request rejection (TRADE_RETCODE_REJECT). */
const MT_REJECT_CODE = 10004;

/**
 * Per-symbol specification cache TTL (Round 7, Fix 1) — mirrors the house
 * pattern of BrokerService.INSTRUMENT_SPEC_CACHE_TTL_MS (60s): short enough
 * that a symbol-spec change at the broker re-resolves quickly, long enough
 * that a risk-validation burst does not hammer the provider with one RPC
 * getSymbolSpecification call per symbol.
 */
const SYMBOL_SPEC_CACHE_TTL_MS = 60_000;

/**
 * MetaTraderAdapter — Full MT4/MT5 integration via MetaAPI cloud platform.
 *
 * Authentication architecture:
 * - Platform-level: METAAPI_TOKEN (env var) → MetaApiClientService singleton
 * - Per-user: MetaAPI accountId UUID stored (encrypted) in BrokerConnection.accountId
 *   This UUID is obtained when the user links their MT account to MetaAPI
 *
 * Connection model:
 * - MetaApiClientService maintains a pool of long-lived RPC connections per accountId
 * - connect(credentials) provisions/retrieves the RPC connection for credentials.accountId
 * - All trading methods use the pooled connection (no re-connect per call)
 *
 * SECURITY INVARIANTS:
 * - credentials parameter is NEVER logged
 * - All monetary values returned as decimal STRINGS — never floats
 * - idempotencyKey is embedded in order comment for broker-side dedup
 * - DEMO mode is validated before LIVE mode can be enabled
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */
@Injectable()
export class MetaTraderAdapter implements IBrokerAdapter {
  private readonly logger = new Logger(MetaTraderAdapter.name);

  readonly brokerId = 'metatrader5';
  readonly brokerName = 'MetaTrader 5 (via MetaAPI)';
  readonly supportsDemo = true;

  private mode: BrokerMode = BrokerMode.DEMO;
  /** MetaAPI account UUID for the currently active user connection */
  private currentAccountId: string | null = null;

  /**
   * Connection-scoped per-symbol specification cache (key
   * `<accountId>:<symbol>`) — the short-lived in-adapter cache behind
   * getInstrumentList()'s per-symbol MetaApi getSymbolSpecification lookups
   * (Round 7, Fix 1). Account-scoped key so an account switch on the shared
   * adapter instance naturally re-resolves instead of serving another
   * account's specifications.
   */
  private readonly symbolSpecCache = new Map<
    string,
    { spec: BrokerInstrument; expiresAt: number }
  >();

  constructor(private readonly metaApiClient: MetaApiClientService) {}

  setMode(mode: BrokerMode): void {
    this.mode = mode;
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  async connect(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    try {
      const conn = await this.metaApiClient.getOrCreateConnection(credentials.accountId);
      this.currentAccountId = credentials.accountId;

      const info = await conn.getAccountInformation();

      return {
        success: true,
        accountId: String(info.login ?? credentials.accountId),
        accountType: this.resolveAccountType(info.type),
        // #7 (round 6): unknown currency stays unknown — NEVER a synthetic
        // 'USD' fallback that would mis-label account money.
        currency: info.currency ?? null,
        serverTime: new Date(),
      };
    } catch (err) {
      this.currentAccountId = null;
      throw this.mapError(err);
    }
  }

  async disconnect(): Promise<void> {
    if (this.currentAccountId) {
      await this.metaApiClient.removeConnection(this.currentAccountId);
      this.currentAccountId = null;
    }
  }

  async testConnection(
    credentials: DecryptedBrokerCredentials,
  ): Promise<BrokerConnectionTestResult> {
    try {
      const result = await this.metaApiClient.testAccountAccess(credentials.accountId);
      return {
        success: result.success,
        accountType: result.accountType === 'DEMO' ? BrokerMode.DEMO : BrokerMode.LIVE,
        currency: result.currency,
        errorMessage: result.error,
      };
    } catch (err) {
      const mapped = this.mapError(err);
      return { success: false, errorCode: mapped.code, errorMessage: mapped.message };
    }
  }

  isConnected(): boolean {
    if (!this.currentAccountId) return false;
    return this.metaApiClient.hasConnection(this.currentAccountId);
  }

  // ─── Account state ────────────────────────────────────────────────────────

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    const conn = await this.getActiveConnection();
    try {
      const info = await conn.getAccountInformation();
      return {
        accountId: String(info.login ?? this.currentAccountId),
        currency: info.currency,
        leverage: info.leverage ?? 0,
        balance: this.toDecimalString(info.balance),
        equity: this.toDecimalString(info.equity),
        margin: this.toDecimalString(info.margin),
        freeMargin: this.toDecimalString(info.freeMargin),
        marginLevel: this.toDecimalString(info.marginLevel ?? 0),
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    const conn = await this.getActiveConnection();
    try {
      const info = await conn.getAccountInformation();
      return {
        balance: this.toDecimalString(info.balance),
        equity: this.toDecimalString(info.equity),
        currency: info.currency,
        timestamp: new Date(),
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    const conn = await this.getActiveConnection();
    try {
      const positions = await conn.getPositions();
      return (positions ?? []).map((p: any) => this.mapPosition(p));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    const conn = await this.getActiveConnection();
    try {
      const position = await conn.getPosition(externalOrderId);
      return position ? this.mapPosition(position) : null;
    } catch (err) {
      const mapped = this.mapError(err);
      if (mapped.code === BrokerErrorCode.POSITION_NOT_FOUND) return null;
      throw mapped;
    }
  }

  // ─── Provider order state (Sprint 50 PR-4 — reconciliation read surface) ──

  /**
   * List OPEN (working) MetaTrader orders via the RPC connection.
   *
   * MetaAPI getOrders() returns pending orders (LIMIT/STOP/STOP_LIMIT) plus
   * market orders in transient request states — exactly the working set
   * reconciliation needs to diff against internal non-terminal orders.
   * Completed orders are NOT included (they live in history; getOrderById
   * resolves those).
   */
  async listOrders(): Promise<BrokerOrderState[]> {
    const conn = await this.getActiveConnection();
    try {
      const orders = await conn.getOrders();
      return (orders ?? []).map((o: any) => this.mapOrderState(o));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * Look up a single order by ticket — open orders first, then history.
   *
   * Resolves uncertain execution results by stable identifier (Directive
   * §26): if the provider known the ticket we learn its ACTUAL state without
   * re-submitting anything. MetaAPI history lookups may still be
   * synchronizing; a `synchronizing` result is treated as "not found yet"
   * (null) — the next reconciliation run retries. NEVER guesses.
   */
  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    const conn = await this.getActiveConnection();
    try {
      // 1. Open (working) orders — authoritative while the order is live.
      const orders = await conn.getOrders();
      const open = (orders ?? []).find((o: any) => String(o.id) === providerOrderId);
      if (open) return this.mapOrderState(open);

      // 2. History (completed) orders by ticket. When history sync is still
      //    in progress the result is incomplete — return null so the caller
      //    retries later rather than concluding "provider never knew it".
      const history = await conn.getHistoryOrdersByTicket(providerOrderId);
      if (!history || history.synchronizing) return null;
      const done = (history.historyOrders ?? []).find((o: any) => String(o.id) === providerOrderId);
      return done ? this.mapOrderState(done) : null;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * Sprint 32 Gate 4: calculate required margin using MetaAPI's native
   * calculate-margin capability.
   *
   * Uses the RPC connection's calculateMargin(order) method through
   * MetaApiClientService, which calls the official MetaAPI WebSocket
   * calculateMargin request (POST /users/current/accounts/:accountId/calculate-margin).
   *
   * This is the PROVIDER-NATIVE margin calculation — not a generic formula.
   * The broker's own margin rules (per instrument, account type, margin mode,
   * leverage) are applied by the broker server.
   *
   * LIVE mode: uses the native MetaAPI calculation (authoritative).
   * If the native calculation returns null/undefined/NaN/Infinity or throws,
   * returns null → Risk Engine fails closed.
   *
   * PAPER/DEMO mode: also uses the native MetaAPI calculation (the demo
   * account's margin rules apply). This is safe because the demo account
   * uses the same instrument specifications as live.
   *
   * No default contractSize = 100000 fallback is used.
   * No local generic leverage formula is used.
   */
  async getRequiredMargin(params: RequiredMarginParams): Promise<string | null> {
    const accountId = params.connectionReference;
    if (!accountId) return null;

    try {
      const openPrice = await this.getOpenPrice(accountId, params.instrument, params.direction);
      if (openPrice === null) return null;

      const volume = parseFloat(params.lotSize);
      if (!Number.isFinite(volume) || volume <= 0) return null;

      const order = {
        symbol: params.instrument,
        type: params.direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
        volume,
        openPrice,
      };

      const margin = await this.metaApiClient.calculateMargin(accountId, order);
      if (margin === null || margin === undefined) return null;
      const parsed = parseFloat(margin);
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      return margin;
    } catch {
      return null;
    }
  }

  // ─── Market data ──────────────────────────────────────────────────────────

  /**
   * Instrument catalog with PROVEN per-symbol specifications (Round 7, Fix 1).
   *
   * Every symbol's digits/minLot/maxLot/lotStep/contractSize comes from the
   * broker's own MetatraderSymbolSpecification via the MetaApi RPC
   * `getSymbolSpecification(symbol)` call — the contractSize geometry
   * RiskOrderGeometryService "proves" for order sizing is the BROKER's
   * truth, never a hardcoded FX constant (the old behavior returned
   * digits=5/minLot 0.01/maxLot 100/lotStep 0.01/contractSize '100000' for
   * EVERY symbol — wrong by orders of magnitude for non-FX instruments
   * such as XAU, indices and crypto on LIVE accounts).
   *
   * FAIL CLOSED: a symbol whose specification cannot be proven (lookup
   * failure or malformed/non-positive geometry fields) is OMITTED from the
   * catalog — exactly the cTrader sibling's discipline ("excluded honestly
   * instead of reporting fake volumes"). NO fabricated FX fallback.
   *
   * Lookups are backed by a short-lived connection-scoped cache (60s TTL,
   * BrokerService.INSTRUMENT_SPEC_CACHE_TTL_MS house pattern) so repeated
   * catalog reads do not re-query the provider per symbol.
   */
  async getInstrumentList(): Promise<BrokerInstrument[]> {
    const conn = await this.getActiveConnection();
    try {
      const symbols: string[] = await conn.getSymbols();
      const instruments: BrokerInstrument[] = [];
      for (const symbol of symbols ?? []) {
        const instrument = await this.getCachedSymbolSpec(conn, symbol);
        if (instrument) instruments.push(instrument);
      }
      return instruments;
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * Resolve ONE symbol's BrokerInstrument through the connection-scoped
   * spec cache. Returns null when the provider specification cannot be
   * PROVEN — the caller omits the symbol (fail-closed, never fabricated).
   */
  private async getCachedSymbolSpec(conn: any, symbol: string): Promise<BrokerInstrument | null> {
    const cacheKey = `${this.currentAccountId ?? 'unconnected'}:${symbol}`;
    const cached = this.symbolSpecCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.spec;

    let spec: any;
    try {
      spec = await conn.getSymbolSpecification(symbol);
    } catch (err) {
      // Fail-closed omission: the symbol is listed by the account but its
      // specification is not provable right now — excluded honestly
      // (cTrader sibling pattern), never reported with invented geometry.
      this.logger.warn(
        `Symbol "${symbol}" specification unavailable — instrument omitted ` +
          `(fail-closed): ${redactString((err as Error)?.message ?? 'unknown error')}`,
      );
      return null;
    }

    const instrument = this.mapSymbolSpecification(symbol, spec);
    if (!instrument) {
      this.logger.warn(
        `Symbol "${symbol}" returned an unprovable specification — instrument omitted (fail-closed)`,
      );
      return null;
    }
    this.symbolSpecCache.set(cacheKey, {
      spec: instrument,
      expiresAt: Date.now() + SYMBOL_SPEC_CACHE_TTL_MS,
    });
    return instrument;
  }

  /**
   * Normalize a MetaApi MetatraderSymbolSpecification into the
   * BrokerInstrument contract (decimal STRINGS for all geometry fields).
   * Returns null when any required field is absent, malformed or
   * non-positive — the specification is then NOT proven and the symbol must
   * be omitted rather than reported with guessed values.
   */
  private mapSymbolSpecification(symbol: string, spec: any): BrokerInstrument | null {
    if (!spec || typeof spec !== 'object') return null;
    const digits =
      typeof spec.digits === 'number' && Number.isInteger(spec.digits) && spec.digits >= 0
        ? spec.digits
        : null;
    const minVolume = this.positiveFiniteNumber(spec.minVolume);
    const maxVolume = this.positiveFiniteNumber(spec.maxVolume);
    const volumeStep = this.positiveFiniteNumber(spec.volumeStep);
    const contractSize = this.positiveFiniteNumber(spec.contractSize);
    if (
      digits === null ||
      minVolume === null ||
      maxVolume === null ||
      volumeStep === null ||
      contractSize === null
    ) {
      return null;
    }
    return {
      symbol,
      description: symbol,
      digits,
      minLot: minVolume.toFixed(8),
      maxLot: maxVolume.toFixed(8),
      lotStep: volumeStep.toFixed(8),
      contractSize: contractSize.toFixed(8),
    };
  }

  /** Positive finite number, or null when the value is absent/unprovable. */
  private positiveFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  async getCurrentPrice(instrument: string): Promise<BrokerPrice> {
    const conn = await this.getActiveConnection();
    try {
      await conn.subscribeToMarketData(instrument);
      const price = await conn.getSymbolPrice(instrument);
      await conn.unsubscribeFromMarketData(instrument);
      return {
        instrument,
        bid: this.toDecimalString(price.bid),
        ask: this.toDecimalString(price.ask),
        spread: this.toDecimalString(price.ask - price.bid),
        timestamp: price.time ?? new Date(),
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async getOHLCV(instrument: string, timeframe: string, count: number): Promise<OHLCV[]> {
    // Precheck: throws BrokerAdapterError(NOT_CONNECTED) if no active connection.
    // The account-level historical-candles API below does not use the returned
    // connection handle directly (it reaches into the connection pool instead),
    // but the precheck preserves the same connectivity gate as every other
    // method on this adapter.
    await this.getActiveConnection();
    try {
      // MetaAPI uses account-level historical candles API
      const entry = this.metaApiClient['connectionPool']?.get(this.currentAccountId!);
      if (!entry)
        throw new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'No active connection');

      const candles = await entry.account.getHistoricalCandles(
        instrument,
        this.mapTimeframe(timeframe),
        new Date(),
        count,
      );
      return (candles ?? []).map((c: any) => ({
        timestamp: c.time,
        open: this.toDecimalString(c.open),
        high: this.toDecimalString(c.high),
        low: this.toDecimalString(c.low),
        close: this.toDecimalString(c.close),
        volume: this.toDecimalString(c.tickVolume ?? c.volume ?? 0),
      }));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── Order management ─────────────────────────────────────────────────────

  // ─── Order capability contract (Round 6 §7) ──────────────────────────────

  /**
   * MetaTrader 5 capability matrix (the DECLARED truth — enforced
   * pre-commitment by the orchestrator + verified by the contract suite):
   * all four normalized kinds; LIMIT/STOP_LIMIT need limitPrice,
   * STOP/STOP_LIMIT need stopPrice; MARKET orders attach SL/TP at placement.
   */
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

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    const conn = order.connectionReference
      ? await this.metaApiClient.getOrCreateConnection(order.connectionReference)
      : await this.getActiveConnection();
    try {
      const lotSize = parseFloat(order.lotSize);
      const sl = parseFloat(order.stopLoss);
      const tp = parseFloat(order.takeProfit);
      // idempotencyKey embedded in comment AND clientId for broker-side dedup;
      // the caller-supplied clientOrderId (when present) is the preferred
      // stable identifier — it survives retries of the whole pipeline.
      const opts = {
        comment: `${order.idempotencyKey}`,
        clientId: order.clientOrderId ?? order.idempotencyKey,
      };

      // Sprint 50 PR-3 — normalized order-kind dispatch. Prices are validated
      // BEFORE any SDK call (fail-fast, never silently downgrade a non-market
      // order to a market order).
      const kind = order.orderKind ?? 'MARKET';
      const limitPrice = this.requirePositiveNumber(order.limitPrice, 'limitPrice');
      const stopPrice = this.requirePositiveNumber(order.stopPrice, 'stopPrice');

      let result: any;
      if (kind === 'MARKET') {
        if (order.direction === 'BUY') {
          result = await conn.createMarketBuyOrder(order.instrument, lotSize, sl, tp, opts);
        } else {
          result = await conn.createMarketSellOrder(order.instrument, lotSize, sl, tp, opts);
        }
      } else if (kind === 'LIMIT') {
        if (limitPrice == null) {
          throw new BrokerAdapterError(
            BrokerErrorCode.INVALID_PRICE,
            'LIMIT order requires a positive limitPrice',
          );
        }
        if (order.direction === 'BUY') {
          result = await conn.createLimitBuyOrder(
            order.instrument,
            lotSize,
            limitPrice,
            sl,
            tp,
            opts,
          );
        } else {
          result = await conn.createLimitSellOrder(
            order.instrument,
            lotSize,
            limitPrice,
            sl,
            tp,
            opts,
          );
        }
      } else if (kind === 'STOP') {
        if (stopPrice == null) {
          throw new BrokerAdapterError(
            BrokerErrorCode.INVALID_PRICE,
            'STOP order requires a positive stopPrice',
          );
        }
        if (order.direction === 'BUY') {
          result = await conn.createStopBuyOrder(
            order.instrument,
            lotSize,
            stopPrice,
            sl,
            tp,
            opts,
          );
        } else {
          result = await conn.createStopSellOrder(
            order.instrument,
            lotSize,
            stopPrice,
            sl,
            tp,
            opts,
          );
        }
      } else if (kind === 'STOP_LIMIT') {
        if (limitPrice == null || stopPrice == null) {
          throw new BrokerAdapterError(
            BrokerErrorCode.INVALID_PRICE,
            'STOP_LIMIT order requires positive stopPrice and limitPrice',
          );
        }
        if (order.direction === 'BUY') {
          result = await conn.createStopLimitBuyOrder(
            order.instrument,
            lotSize,
            stopPrice,
            limitPrice,
            sl,
            tp,
            opts,
          );
        } else {
          result = await conn.createStopLimitSellOrder(
            order.instrument,
            lotSize,
            stopPrice,
            limitPrice,
            sl,
            tp,
            opts,
          );
        }
      } else {
        throw new BrokerAdapterError(
          BrokerErrorCode.INVALID_ORDER_TYPE,
          `Unsupported order kind: ${String(kind)}`,
        );
      }

      const success = result?.stringCode === MT_SUCCESS_CODE;
      // Pending orders (LIMIT/STOP/STOP_LIMIT) rest at the provider when
      // accepted — they are NOT filled. MetaAPI reports the orderId; the
      // positionId appears when the order eventually triggers.
      const isPendingOrder = kind !== 'MARKET';
      return {
        success,
        externalOrderId: result?.positionId ?? result?.orderId,
        filledAt: success && !isPendingOrder ? new Date() : undefined,
        status: success
          ? isPendingOrder
            ? 'PENDING'
            : 'FILLED'
          : result?.numericCode === 10004
            ? 'REJECTED'
            : 'FAILED',
        brokerMessage: result?.message,
        rawResponse: result,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * Parse a decimal string into a positive finite number, or null when the
   * value is absent/unparseable. Validation of REQUIRED-ness is the caller's
   * (fail-fast before any SDK call).
   */
  private requirePositiveNumber(value: string | undefined, field: string): number | null {
    if (value == null || value.trim() === '') return null;
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_PRICE,
        `${field} must be a positive decimal string (got: ${value})`,
      );
    }
    return parsed;
  }

  async modifyOrder(
    externalOrderId: string,
    modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult> {
    const conn = await this.getActiveConnection();
    try {
      const sl = modifications.newStopLoss ? parseFloat(modifications.newStopLoss) : undefined;
      const tp = modifications.newTakeProfit ? parseFloat(modifications.newTakeProfit) : undefined;

      const result = await conn.modifyPosition(externalOrderId, sl, tp);
      const success = result?.stringCode === MT_SUCCESS_CODE;
      return {
        success,
        externalOrderId,
        status: success ? 'FILLED' : 'FAILED',
        brokerMessage: result?.message,
        rawResponse: result,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async closeOrder(externalOrderId: string, lotSize?: string): Promise<BrokerOrderResult> {
    const conn = await this.getActiveConnection();
    try {
      let result: any;
      if (lotSize) {
        result = await conn.closePositionPartially(externalOrderId, parseFloat(lotSize));
      } else {
        result = await conn.closePosition(externalOrderId);
      }
      const success = result?.stringCode === MT_SUCCESS_CODE;
      return {
        success,
        externalOrderId,
        filledAt: success ? new Date() : undefined,
        status: success ? 'FILLED' : 'FAILED',
        brokerMessage: result?.message,
        rawResponse: result,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── ADDITIVE CONCRETE SURFACE — NOT part of IBrokerAdapter ───────────────

  /**
   * Cancels a WORKING (pending) order through the MetaApi RPC `cancelOrder`
   * command (orderId = the order ticket number; MetaApi relays it to the
   * terminal as a trade request, and the terminal answers with the
   * authoritative retcode).
   *
   * ADDITIVE CONCRETE METHOD (Sprint 50/51 contract decision — mirrors the
   * cTrader/paper siblings): cancelOrder is deliberately NOT declared on the
   * shared IBrokerAdapter interface. The provider-verification harness
   * narrows with `'cancelOrder' in adapter` to exercise it on adapters that
   * implement it (pending-cancel step). Do NOT widen the shared interface
   * for this method; do NOT remove it from this adapter.
   *
   * WRITE-CERTAINTY discipline (same truth table as every state-changing
   * call on this adapter, mapError): gateway-level rejections (401/429 —
   * rejected BEFORE the terminal) are DEFINITELY_NOT_SENT — safe to retry;
   * timeouts / connection loss / 5xx AFTER submission are
   * MAY_HAVE_REACHED_PROVIDER — the terminal may have cancelled the order;
   * reconcile, never resend; terminal-ANSWERED rejections (order not found,
   * invalid ticket) are SENT_RESPONSE_RECEIVED — the broker definitively
   * reported the outcome.
   */
  async cancelOrder(externalOrderId: string): Promise<BrokerOrderResult> {
    try {
      // Inside the try so the pre-send NOT_CONNECTED rejection also flows
      // through mapError's certainty fill (DEFINITELY_NOT_SENT) — every
      // error path of this state-changing call carries a classification.
      const conn = await this.getActiveConnection();
      const result = await conn.cancelOrder(externalOrderId);
      const success = result?.stringCode === MT_SUCCESS_CODE;
      return {
        success,
        externalOrderId,
        status: success ? 'FILLED' : result?.numericCode === MT_REJECT_CODE ? 'REJECTED' : 'FAILED',
        brokerMessage: result?.message,
        rawResponse: result,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    const positions = await this.getOpenPositions();
    let closedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    await Promise.allSettled(
      positions.map(async (pos) => {
        try {
          const result = await this.closeOrder(pos.externalOrderId);
          if (result.success) closedCount++;
          else {
            failedCount++;
            errors.push(`${pos.externalOrderId}: ${result.brokerMessage ?? 'failed'}`);
          }
        } catch (err) {
          failedCount++;
          errors.push(`${pos.externalOrderId}: ${(err as Error).message}`);
        }
      }),
    );

    return { closedCount, failedCount, errors };
  }

  // ─── Trade history ─────────────────────────────────────────────────────────

  async getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]> {
    const conn = await this.getActiveConnection();
    try {
      const deals = await conn.getDealsByTimeRange(from, to);
      return (deals ?? [])
        .filter(
          (d: any) =>
            d.entryType === 'DEAL_ENTRY_OUT' &&
            (d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL'),
        )
        .map((d: any) => this.mapClosedDeal(d));
    } catch (err) {
      throw this.mapError(err);
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async getActiveConnection(): Promise<any> {
    if (!this.currentAccountId) {
      throw new BrokerAdapterError(
        BrokerErrorCode.NOT_CONNECTED,
        'No active connection. Call connect() first.',
        undefined,
        false,
      );
    }
    try {
      return await this.metaApiClient.getOrCreateConnection(this.currentAccountId);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Resolve side-correct price using an explicit MetaAPI account reference. */
  private async getOpenPrice(
    accountId: string,
    instrument: string,
    direction: string,
  ): Promise<number | null> {
    const connection = await this.metaApiClient.getOrCreateConnection(accountId);
    try {
      await connection.subscribeToMarketData(instrument);
      const price = await connection.getSymbolPrice(instrument);
      const priceValue = direction === 'BUY' ? Number(price?.ask) : Number(price?.bid);
      if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
      return priceValue;
    } catch {
      return null;
    } finally {
      try {
        await connection.unsubscribeFromMarketData(instrument);
      } catch {
        // Best-effort market-data cleanup; validation itself fails closed.
      }
    }
  }

  private toDecimalString(value: number | undefined | null): string {
    if (value === undefined || value === null) return '0';
    return value.toFixed(8);
  }

  private resolveAccountType(mtType: string | undefined): BrokerMode {
    if (!mtType) return this.mode;
    return mtType.includes('DEMO') ? BrokerMode.DEMO : BrokerMode.LIVE;
  }

  /**
   * Map iRexPro timeframe strings to MetaAPI timeframe strings.
   * MetaAPI uses: '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mn'
   */
  private mapTimeframe(tf: string): string {
    const map: Record<string, string> = {
      M1: '1m',
      M5: '5m',
      M15: '15m',
      M30: '30m',
      H1: '1h',
      H4: '4h',
      D1: '1d',
      W1: '1w',
      MN1: '1mn',
      '1m': '1m',
      '5m': '5m',
      '15m': '15m',
      '1h': '1h',
      '4h': '4h',
      '1d': '1d',
    };
    return map[tf] ?? tf;
  }

  private mapPosition(p: any): BrokerPosition {
    return {
      externalOrderId: String(p.id),
      instrument: p.symbol,
      direction: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
      lotSize: this.toDecimalString(p.volume),
      openPrice: this.toDecimalString(p.openPrice),
      currentPrice: this.toDecimalString(p.currentPrice),
      stopLoss: this.toDecimalString(p.stopLoss),
      takeProfit: this.toDecimalString(p.takeProfit),
      unrealisedPnl: this.toDecimalString(p.profit),
      openedAt: p.time ?? new Date(),
      commission: this.toDecimalString(p.commission),
      swap: this.toDecimalString(p.swap),
    };
  }

  /**
   * Sprint 50 PR-4 — normalize a MetatraderOrder (open or history) into the
   * reconciliation BrokerOrderState contract.
   *
   * - Filled quantity = requested volume − remaining currentVolume (MetaAPI
   *   reports both; the difference is the filled part).
   * - Unrecognized ORDER_STATE_* values map to UNKNOWN — reconciliation
   *   must fail closed on ambiguity, never guess an interpretation.
   * - Unknown order types map to null orderKind (kind is informational for
   *   reconciliation; state is what drives resolution).
   */
  private mapOrderState(o: any): BrokerOrderState {
    const requested = typeof o.volume === 'number' ? o.volume : 0;
    const remaining = typeof o.currentVolume === 'number' ? o.currentVolume : requested;
    const filled = Math.max(0, requested - remaining);
    const isBuy = String(o.type ?? '').includes('BUY');

    return {
      providerOrderId: String(o.id),
      clientOrderId: o.clientId ? String(o.clientId) : null,
      status: this.mapOrderStatus(String(o.state ?? '')),
      instrument: o.symbol ?? '',
      direction: isBuy ? 'BUY' : 'SELL',
      requestedQuantity: this.toDecimalString(requested),
      filledQuantity: this.toDecimalString(filled),
      // For working pending orders MetaAPI reports openPrice as the order's
      // price level; a fill price is only meaningful once volume filled.
      avgFillPrice: filled > 0 ? this.toDecimalString(o.openPrice) : null,
      orderKind: this.mapOrderKind(String(o.type ?? '')),
      limitPrice: this.toDecimalString(o.openPrice),
      stopPrice: o.stopLoss !== undefined ? this.toDecimalString(o.stopLoss) : null,
      timeInForce: null,
      placedAt: o.time ?? null,
      updatedAt: o.doneTime ?? null,
    };
  }

  private mapOrderStatus(state: string): BrokerOrderState['status'] {
    switch (state) {
      case 'ORDER_STATE_STARTED':
      case 'ORDER_STATE_PLACED':
      case 'ORDER_STATE_REQUEST_ADD':
      case 'ORDER_STATE_REQUEST_MODIFY':
      case 'ORDER_STATE_REQUEST_CANCEL':
        return 'WORKING';
      case 'ORDER_STATE_PARTIAL':
        return 'PARTIALLY_FILLED';
      case 'ORDER_STATE_FILLED':
        return 'FILLED';
      case 'ORDER_STATE_CANCELED':
        return 'CANCELLED';
      case 'ORDER_STATE_REJECTED':
        return 'REJECTED';
      case 'ORDER_STATE_EXPIRED':
        return 'EXPIRED';
      default:
        // Fail-closed: unrecognized provider state must never be guessed.
        return 'UNKNOWN';
    }
  }

  private mapOrderKind(type: string): BrokerOrderState['orderKind'] {
    switch (type) {
      case 'ORDER_TYPE_BUY':
      case 'ORDER_TYPE_SELL':
        return 'MARKET';
      case 'ORDER_TYPE_BUY_LIMIT':
      case 'ORDER_TYPE_SELL_LIMIT':
        return 'LIMIT';
      case 'ORDER_TYPE_BUY_STOP':
      case 'ORDER_TYPE_SELL_STOP':
        return 'STOP';
      case 'ORDER_TYPE_BUY_STOP_LIMIT':
      case 'ORDER_TYPE_SELL_STOP_LIMIT':
        return 'STOP_LIMIT';
      default:
        return null;
    }
  }

  private mapClosedDeal(d: any): BrokerClosedTrade {
    const closeReason = this.resolveCloseReason(d);
    return {
      externalOrderId: String(d.id),
      instrument: d.symbol ?? '',
      direction: d.type === 'DEAL_TYPE_BUY' ? 'BUY' : 'SELL',
      lotSize: this.toDecimalString(d.volume),
      openPrice: '0', // deals don't carry open price — use reconciliation against positions
      closePrice: this.toDecimalString(d.price),
      stopLoss: '0',
      takeProfit: '0',
      realisedPnl: this.toDecimalString(d.profit),
      openedAt: d.time ?? new Date(),
      closedAt: d.time ?? new Date(),
      commission: this.toDecimalString(d.commission),
      swap: this.toDecimalString(d.swap ?? 0),
      closeReason,
    };
  }

  private resolveCloseReason(d: any): BrokerClosedTrade['closeReason'] {
    const reason = d.reason?.toLowerCase() ?? '';
    if (reason.includes('sl') || reason === 'deal_reason_sl') return 'SL';
    if (reason.includes('tp') || reason === 'deal_reason_tp') return 'TP';
    if (reason.includes('client') || reason === 'deal_reason_client') return 'MANUAL';
    if (reason.includes('expert') || reason === 'deal_reason_expert') return 'SYSTEM';
    return 'UNKNOWN';
  }

  /**
   * Map MetaAPI / network errors to typed BrokerAdapterError.
   * Never includes raw credentials in the error message.
   *
   * Sprint 56 credential redaction (merged from the orphan sprint): raw
   * provider text may echo credentials (tokens/keys in error bodies). It is
   * sanitized BEFORE entering any BrokerAdapterError field; the classifier
   * below still reads the raw text. Complements the interface's
   * redactSecret() (known-secret replacement) with pattern-based scrubbing
   * of credential-shaped fragments the adapter does not know verbatim.
   */
  /**
   * WRITE-CERTAINTY (Sprint 56 correction round 4, architect finding 6):
   * every classification below is tagged with the certainty that the
   * state-changing request left iRexPro. MetaApi commands relay through the
   * MetaApi CLOUD to the broker terminal, so:
   * - gateway-level rejections (401/429 — rejected BEFORE the terminal) are
   *   DEFINITELY_NOT_SENT — nothing reached the broker; safe to retry;
   * - timeouts / connection loss / 5xx AFTER submission are
   *   MAY_HAVE_REACHED_PROVIDER — the terminal may have executed the
   *   command; reconcile, never resend;
   * - terminal-ANSWERED rejections (position not found, market closed,
   *   margin, duplicate, symbol) are SENT_RESPONSE_RECEIVED — the broker
   *   definitively reported the outcome.
   * Local validation errors thrown BEFORE any SDK call carry their own
   * DEFINITELY_NOT_SENT classification.
   */
  mapError(err: unknown): BrokerAdapterError {
    if (err instanceof BrokerAdapterError) {
      // Pre-send local validation keeps its explicit classification; raw
      // provider/SDK failures get the truth table below.
      return withDefaultCertainty(err);
    }

    const raw = (err as any)?.message ?? 'Unknown MetaAPI error';
    const message = redactString(raw);
    const status = (err as any)?.status ?? (err as any)?.statusCode;
    const lower = raw.toLowerCase();

    if (status === 401 || lower.includes('authentication') || lower.includes('unauthorized')) {
      return new BrokerAdapterError(
        BrokerErrorCode.AUTHENTICATION_FAILED,
        message,
        message,
        false,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
    if (status === 404 || lower.includes('not found') || lower.includes('position not found')) {
      return new BrokerAdapterError(
        BrokerErrorCode.POSITION_NOT_FOUND,
        message,
        message,
        false,
        ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED,
      );
    }
    if (status === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
      return new BrokerAdapterError(
        BrokerErrorCode.RATE_LIMITED,
        message,
        message,
        true,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      );
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
      return new BrokerAdapterError(
        BrokerErrorCode.CONNECTION_TIMEOUT,
        message,
        message,
        true,
        ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
      );
    }
    if (lower.includes('connection') && (lower.includes('lost') || lower.includes('closed'))) {
      return new BrokerAdapterError(
        BrokerErrorCode.CONNECTION_LOST,
        message,
        message,
        true,
        ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
      );
    }
    if (lower.includes('market closed') || lower.includes('trade disabled')) {
      return new BrokerAdapterError(
        BrokerErrorCode.MARKET_CLOSED,
        message,
        message,
        false,
        ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED,
      );
    }
    if (lower.includes('insufficient margin') || lower.includes('not enough money')) {
      return new BrokerAdapterError(
        BrokerErrorCode.INSUFFICIENT_MARGIN,
        message,
        message,
        false,
        ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED,
      );
    }
    if (lower.includes('invalid symbol') || lower.includes('unknown symbol')) {
      return new BrokerAdapterError(
        BrokerErrorCode.INVALID_INSTRUMENT,
        message,
        message,
        false,
        ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED,
      );
    }
    if (lower.includes('duplicate') || lower.includes('client id')) {
      return new BrokerAdapterError(
        BrokerErrorCode.DUPLICATE_ORDER,
        message,
        message,
        false,
        ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED,
      );
    }
    if (status >= 500 || lower.includes('internal server error')) {
      return new BrokerAdapterError(
        BrokerErrorCode.BROKER_SERVER_ERROR,
        message,
        message,
        true,
        ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
      );
    }

    return new BrokerAdapterError(
      BrokerErrorCode.UNKNOWN,
      message,
      message,
      false,
      ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
    );
  }
}
