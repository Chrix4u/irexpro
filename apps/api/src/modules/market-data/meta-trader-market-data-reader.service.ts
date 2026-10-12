import { Injectable } from '@nestjs/common';
import { BrokerAdapterError, BrokerErrorCode } from '../broker/interfaces/broker-adapter.errors';
import { BrokerPrice, OHLCV } from '../broker/interfaces/broker-adapter.interface';
import { MetaApiClientService } from '../broker/services/metaapi-client.service';

interface HistoricalCandleAccount {
  getHistoricalCandles(
    instrument: string,
    timeframe: string,
    startTime: Date,
    count: number,
  ): Promise<
    Array<{
      time: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      tickVolume?: number;
      volume?: number;
    }>
  >;
}

interface MetaApiPoolEntryView {
  account: HistoricalCandleAccount;
}

interface MetaApiPoolView {
  connectionPool: Map<string, MetaApiPoolEntryView>;
}

interface MetaApiQuote {
  bid?: number;
  ask?: number;
  time?: Date | string | number;
}

/**
 * Account-scoped MetaTrader market-data reader.
 *
 * Unlike MetaTraderAdapter's legacy market-data methods, this reader never
 * relies on mutable adapter.currentAccountId. Every request carries the
 * decrypted MetaAPI account reference through to the pooled connection lookup,
 * preventing concurrent users from racing onto another account's market feed.
 *
 * Current quotes prefer MetaAPI's persistent streaming terminal state. This
 * avoids a blocking RPC round-trip on every scanner cycle while keeping the
 * existing RPC quote path as a fail-closed fallback when streaming data is not
 * yet available.
 */
@Injectable()
export class MetaTraderMarketDataReaderService {
  private readonly marketDataSubscriptions = new WeakMap<object, Map<string, Promise<void>>>();

  constructor(private readonly metaApiClient: MetaApiClientService) {}

  async getCurrentPrice(accountId: string, instrument: string): Promise<BrokerPrice> {
    let streamingConnection: any;
    try {
      streamingConnection = await this.metaApiClient.getOrCreateStreamingConnection(accountId);
      await this.ensureMarketDataSubscription(streamingConnection, instrument);

      const streamingPrice = streamingConnection.terminalState?.price?.(instrument) as
        | MetaApiQuote
        | undefined;
      if (this.isValidQuote(streamingPrice)) {
        return this.toBrokerPrice(instrument, streamingPrice);
      }
    } catch {
      // If the streaming connection itself failed, evict it so the next scanner
      // cycle can build a clean websocket session. The RPC fallback below still
      // gets one opportunity to supply a valid quote for this cycle.
      if (streamingConnection) {
        await this.metaApiClient.removeStreamingConnection(accountId, streamingConnection);
      }
    }

    return this.getCurrentPriceViaRpc(accountId, instrument);
  }

  async getOHLCV(
    accountId: string,
    instrument: string,
    timeframe: string,
    count: number,
  ): Promise<OHLCV[]> {
    // Ensure this exact account has a live pooled connection before reading its
    // account-level historical candle API.
    await this.metaApiClient.getOrCreateConnection(accountId, {
      requireSynchronization: false,
    });

    const pool = (this.metaApiClient as unknown as MetaApiPoolView).connectionPool;
    const entry = pool.get(accountId);
    if (!entry) {
      throw new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'No active broker connection');
    }

    const candles = await entry.account.getHistoricalCandles(
      instrument,
      this.mapTimeframe(timeframe),
      new Date(),
      count,
    );

    return (candles ?? []).map((candle) => ({
      timestamp: candle.time,
      open: this.toDecimalString(candle.open),
      high: this.toDecimalString(candle.high),
      low: this.toDecimalString(candle.low),
      close: this.toDecimalString(candle.close),
      volume: this.toDecimalString(candle.tickVolume ?? candle.volume ?? 0),
    }));
  }

  private async getCurrentPriceViaRpc(accountId: string, instrument: string): Promise<BrokerPrice> {
    const connection = await this.metaApiClient.getOrCreateConnection(accountId, {
      requireSynchronization: true,
    });
    try {
      await this.ensureMarketDataSubscription(connection, instrument);
      const price = (await connection.getSymbolPrice(instrument)) as MetaApiQuote;
      if (!this.isValidQuote(price)) {
        throw new BrokerAdapterError(
          BrokerErrorCode.BROKER_SERVER_ERROR,
          'Broker returned an invalid market quote',
        );
      }
      return this.toBrokerPrice(instrument, price);
    } catch (err) {
      await this.metaApiClient.removeConnection(accountId, connection);
      throw err;
    }
  }

  private async ensureMarketDataSubscription(connection: any, instrument: string): Promise<void> {
    const connectionKey = connection as object;
    let subscriptions = this.marketDataSubscriptions.get(connectionKey);
    if (!subscriptions) {
      subscriptions = new Map<string, Promise<void>>();
      this.marketDataSubscriptions.set(connectionKey, subscriptions);
    }

    const existing = subscriptions.get(instrument);
    if (existing) {
      return existing;
    }

    const subscription = Promise.resolve()
      .then(() => connection.subscribeToMarketData(instrument))
      .then(() => undefined)
      .catch((err) => {
        if (subscriptions?.get(instrument) === subscription) {
          subscriptions.delete(instrument);
        }
        throw err;
      });
    subscriptions.set(instrument, subscription);
    return subscription;
  }

  private isValidQuote(price: MetaApiQuote | undefined): price is MetaApiQuote {
    const bid = Number(price?.bid);
    const ask = Number(price?.ask);
    return Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid;
  }

  private toBrokerPrice(instrument: string, price: MetaApiQuote): BrokerPrice {
    const bid = Number(price.bid);
    const ask = Number(price.ask);
    return {
      instrument,
      bid: this.toDecimalString(bid),
      ask: this.toDecimalString(ask),
      spread: this.toDecimalString(ask - bid),
      timestamp: price.time instanceof Date ? price.time : new Date(price.time ?? Date.now()),
    };
  }

  private toDecimalString(value: number): string {
    if (!Number.isFinite(value)) {
      throw new BrokerAdapterError(BrokerErrorCode.BROKER_SERVER_ERROR, 'Invalid broker decimal');
    }
    return value.toFixed(8);
  }

  private mapTimeframe(timeframe: string): string {
    const map: Record<string, string> = {
      M1: '1m',
      M5: '5m',
      M15: '15m',
      M30: '30m',
      H1: '1h',
      H4: '4h',
      D1: '1d',
    };
    return map[timeframe] ?? timeframe;
  }
}
