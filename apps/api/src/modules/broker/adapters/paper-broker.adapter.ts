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
 * Use cases:
 * - Paper-mode end-to-end signal pipeline tests
 * - Development/CI testing without real broker credentials
 * - Verifying the Strategy → Risk → Execution pathway without side effects
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
    return [];
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

  async getPositionById(_externalOrderId: string): Promise<BrokerPosition | null> {
    return null;
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
    const kind = order.orderKind ?? 'MARKET';

    this.logger.log(
      `PaperBrokerAdapter: simulated order placed ` +
        `id=${orderId} instrument=${order.instrument} dir=${order.direction} ` +
        `lot=${order.lotSize} kind=${kind} [PAPER_ONLY — no real order placed]`,
    );

    if (kind === 'MARKET') {
      return {
        success: true,
        externalOrderId: orderId,
        filledPrice: '1.10005',
        filledQuantity: order.lotSize,
        filledAt: new Date(),
        status: 'FILLED',
        brokerMessage: 'PAPER_ONLY simulated fill',
      };
    }

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
    return {
      success: true,
      externalOrderId,
      filledAt: new Date(),
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
    return [];
  }
}
