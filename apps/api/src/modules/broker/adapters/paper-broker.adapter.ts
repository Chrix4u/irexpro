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

/**
 * PaperBrokerAdapter — safe simulated broker for paper trading only.
 *
 * PAPER_ONLY:
 * - Never calls any external broker API.
 * - Never places real orders.
 * - Returns deterministic/simulated data.
 * - Cannot be enabled for live trading.
 * - liveTradingEnabled is always false.
 *
 * Sprint 50 PR-4 — HONEST PROVIDER STATE: the adapter now tracks the orders
 * and positions it "fills" in-memory so that its read surface
 * (listOrders/getOrderById/getOpenPositions/getPositionById/
 * getClosedTrades/closeOrder) reflects the simulated account truthfully.
 * Reconciliation against a paper connection therefore observes real
 * (simulated) provider state instead of an always-empty universe — which
 * previously made every OPEN paper trade look broker-closed.
 *
 * State is keyed by externalOrderId in a single in-memory map. The paper
 * adapter serves test/dev accounts only — per-connection isolation is NOT
 * provided (same as the pre-existing single simulated balance).
 *
 * Use cases:
 * - Paper-mode end-to-end signal pipeline tests
 * - Development/CI testing without real broker credentials
 * - Verifying the Strategy → Risk → Execution → Reconciliation pathway
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */
@Injectable()
export class PaperBrokerAdapter implements IBrokerAdapter {
  private readonly logger = new Logger(PaperBrokerAdapter.name);

  readonly brokerId = 'paper-broker';
  readonly brokerName = 'Paper Trading Broker (Simulated — PAPER_ONLY)';
  readonly supportsDemo = true;

  private _connected = false;
  private _mode: BrokerMode = BrokerMode.DEMO;
  private _orderCounter = 0;

  /** Simulated balance for paper trading. */
  private _balance = '10000.00';
  private readonly _currency = 'USD';

  /** Sprint 50 PR-4 — in-memory simulated provider state. */
  private readonly _openOrders = new Map<string, BrokerOrderState>();
  private readonly _openPositions = new Map<string, BrokerPosition>();
  private readonly _closedPositions = new Map<string, BrokerClosedTrade>();

  setMode(mode: BrokerMode): void {
    if (mode === BrokerMode.LIVE) {
      this.logger.warn('PaperBrokerAdapter cannot be set to LIVE mode. Ignoring setMode(LIVE).');
      return;
    }
    this._mode = mode;
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  async connect(_credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult> {
    // Credentials intentionally ignored — paper broker needs none.
    this._connected = true;
    this.logger.log('PaperBrokerAdapter connected (simulated)');
    return {
      success: true,
      accountId: 'paper-account-001',
      accountType: BrokerMode.DEMO,
      currency: this._currency,
      serverTime: new Date(),
    };
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.logger.log('PaperBrokerAdapter disconnected');
  }

  async testConnection(
    _credentials: DecryptedBrokerCredentials,
  ): Promise<BrokerConnectionTestResult> {
    return {
      success: true,
      accountId: 'paper-account-001',
      accountType: BrokerMode.DEMO,
      currency: this._currency,
    };
  }

  isConnected(): boolean {
    return this._connected;
  }

  // ─── Account state ────────────────────────────────────────────────────────

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    return {
      accountId: 'paper-account-001',
      currency: this._currency,
      leverage: 100,
      balance: this._balance,
      equity: this._balance,
      margin: '0.00',
      freeMargin: this._balance,
      marginLevel: '0.00',
    };
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    return {
      balance: this._balance,
      equity: this._balance,
      currency: this._currency,
      timestamp: new Date(),
    };
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    return Array.from(this._openPositions.values());
  }

  /**
   * Sprint 32 Gate 2: calculate required margin for a proposed order.
   *
   * Paper broker uses a deterministic formula:
   *   requiredMargin = (lotSize × contractSize × currentPrice) / leverage
   *
   * For paper trading, we look up the instrument from the instrument list
   * to get contractSize, and use getCurrentPrice for the current price.
   * Returns null if the instrument is not found or the price is unavailable.
   */
  async getRequiredMargin(params: RequiredMarginParams): Promise<string | null> {
    try {
      const instruments = await this.getInstrumentList();
      const instrument = instruments.find((i) => i.symbol === params.instrument);
      if (!instrument) return null;

      const price = await this.getCurrentPrice(params.instrument);
      if (!price) return null;

      const lotSize = parseFloat(params.lotSize);
      const contractSize = parseFloat(instrument.contractSize);
      // Use the mid-price (average of bid/ask) for margin calculation
      const currentPrice = (parseFloat(price.bid) + parseFloat(price.ask)) / 2;
      const leverage = 100; // paper broker default leverage

      if (lotSize <= 0 || contractSize <= 0 || currentPrice <= 0 || leverage <= 0) {
        return null;
      }

      const requiredMargin = (lotSize * contractSize * currentPrice) / leverage;
      return requiredMargin.toFixed(2);
    } catch {
      return null;
    }
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    return this._openPositions.get(externalOrderId) ?? null;
  }

  // ─── Provider order state (Sprint 50 PR-4 — reconciliation read surface) ──

  async listOrders(): Promise<BrokerOrderState[]> {
    return Array.from(this._openOrders.values());
  }

  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    return this._openOrders.get(providerOrderId) ?? null;
  }

  // ─── Market data ──────────────────────────────────────────────────────────

  async getInstrumentList(): Promise<BrokerInstrument[]> {
    return [
      {
        symbol: 'EURUSD',
        description: 'Euro vs US Dollar (Paper)',
        digits: 5,
        minLot: '0.01',
        maxLot: '100.00',
        lotStep: '0.01',
        contractSize: '100000',
      },
    ];
  }

  async getCurrentPrice(instrument: string): Promise<BrokerPrice> {
    return {
      instrument: instrument.toUpperCase(),
      bid: '1.10000',
      ask: '1.10010',
      spread: '0.00010',
      timestamp: new Date(),
    };
  }

  async getOHLCV(instrument: string, timeframe: string, count: number): Promise<OHLCV[]> {
    // Return deterministic mock candles for paper testing
    const candles: OHLCV[] = [];
    const base = 1.1;
    const now = new Date();

    for (let i = count - 1; i >= 0; i--) {
      const ts = new Date(now.getTime() - i * 60 * 60 * 1000);
      const open = String((base + Math.sin(i * 0.1) * 0.005).toFixed(5));
      const close = String((base + Math.sin((i + 1) * 0.1) * 0.005).toFixed(5));
      const high = String((Math.max(parseFloat(open), parseFloat(close)) + 0.0002).toFixed(5));
      const low = String((Math.min(parseFloat(open), parseFloat(close)) - 0.0002).toFixed(5));
      candles.push({
        timestamp: ts,
        open,
        high,
        low,
        close,
        volume: '1000',
      });
    }

    this.logger.debug(
      `PaperBrokerAdapter: returning ${count} mock candles for ${instrument} ${timeframe}`,
    );
    return candles;
  }

  // ─── Order management ─────────────────────────────────────────────────────

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    this._orderCounter += 1;
    const orderId = `paper-order-${this._orderCounter.toString().padStart(6, '0')}`;

    // Sprint 50 PR-3 — honest order-kind semantics: MARKET orders fill
    // immediately at the deterministic paper price; LIMIT/STOP/STOP_LIMIT
    // orders are accepted as WORKING orders resting at the paper provider
    // (never silently downgraded to market fills).
    //
    // Sprint 50 PR-4 — the fill/rest is now REFLECTED in the in-memory
    // provider state so reconciliation observes the truth: market orders
    // open a simulated position; working orders rest in _openOrders.
    const kind = order.orderKind ?? 'MARKET';
    const now = new Date();

    this.logger.log(
      `PaperBrokerAdapter: simulated order placed ` +
        `id=${orderId} instrument=${order.instrument} dir=${order.direction} ` +
        `lot=${order.lotSize} kind=${kind} [PAPER_ONLY — no real order placed]`,
    );

    if (kind === 'MARKET') {
      const fillPrice = '1.10005';
      this._openPositions.set(orderId, {
        externalOrderId: orderId,
        instrument: order.instrument,
        direction: order.direction,
        lotSize: order.lotSize,
        openPrice: fillPrice,
        currentPrice: fillPrice,
        stopLoss: order.stopLoss ?? '0',
        takeProfit: order.takeProfit ?? '0',
        unrealisedPnl: '0.00',
        openedAt: now,
        commission: '0.00',
        swap: '0.00',
      });
      return {
        success: true,
        externalOrderId: orderId,
        filledPrice: fillPrice,
        filledQuantity: order.lotSize,
        filledAt: now,
        status: 'FILLED',
        brokerMessage: 'PAPER_ONLY simulated fill',
      };
    }

    this._openOrders.set(orderId, {
      providerOrderId: orderId,
      clientOrderId: order.clientOrderId ?? null,
      status: 'WORKING',
      instrument: order.instrument,
      direction: order.direction,
      requestedQuantity: order.lotSize,
      filledQuantity: '0.0000',
      avgFillPrice: null,
      orderKind: kind,
      limitPrice: order.limitPrice ?? null,
      stopPrice: order.stopPrice ?? null,
      timeInForce: order.timeInForce ?? 'GTC',
      placedAt: now,
      updatedAt: now,
    });

    return {
      success: true,
      externalOrderId: orderId,
      status: 'PENDING',
      brokerMessage: `PAPER_ONLY simulated working ${kind} order`,
    };
  }

  async modifyOrder(
    externalOrderId: string,
    _modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult> {
    return {
      success: true,
      externalOrderId,
      status: 'FILLED',
      brokerMessage: 'PAPER_ONLY simulated modification',
    };
  }

  async closeOrder(externalOrderId: string, _lotSize?: string): Promise<BrokerOrderResult> {
    // Sprint 50 PR-4 — closing a simulated position MOVES it to the closed
    // list with deterministic exit economics so getClosedTrades() reflects
    // the truth. Closing an unknown id fails honestly (no silent success).
    const position = this._openPositions.get(externalOrderId);
    const now = new Date();

    if (!position) {
      return {
        success: false,
        externalOrderId,
        status: 'REJECTED',
        brokerMessage: 'PAPER_ONLY: unknown position — nothing to close',
      };
    }

    const closePrice = '1.10005';
    this._openPositions.delete(externalOrderId);
    this._closedPositions.set(externalOrderId, {
      externalOrderId,
      instrument: position.instrument,
      direction: position.direction,
      lotSize: position.lotSize,
      openPrice: position.openPrice,
      closePrice,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      realisedPnl: '0.00', // deterministic paper close: flat
      openedAt: position.openedAt,
      closedAt: now,
      commission: '0.00',
      swap: '0.00',
      closeReason: 'MANUAL',
    });

    return {
      success: true,
      externalOrderId,
      filledPrice: closePrice,
      filledAt: now,
      status: 'FILLED',
      brokerMessage: 'PAPER_ONLY simulated close',
    };
  }

  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    this.logger.log('PaperBrokerAdapter: closeAllOrders called [PAPER_ONLY]');
    return { closedCount: 0, failedCount: 0, errors: [] };
  }

  // ─── Trade history ────────────────────────────────────────────────────────

  async getClosedTrades(_from: Date, _to: Date): Promise<BrokerClosedTrade[]> {
    return Array.from(this._closedPositions.values());
  }
}
