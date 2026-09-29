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

/**
 * Account-scoped MetaTrader market-data reader.
 *
 * Unlike MetaTraderAdapter's legacy market-data methods, this reader never
 * relies on mutable adapter.currentAccountId. Every request carries the
 * decrypted MetaAPI account reference through to the pooled connection lookup,
 * preventing concurrent users from racing onto another account's market feed.
 */
@Injectable()
export class MetaTraderMarketDataReaderService {
  constructor(private readonly metaApiClient: MetaApiClientService) {}

  async getCurrentPrice(accountId: string, instrument: string): Promise<BrokerPrice> {
    const connection = await this.metaApiClient.getOrCreateConnection(accountId);

    // RPC connections expose direct quote reads. subscribeToMarketData() is a
    // streaming-connection API and is not available on MetaApi RPC connections.
    const price = await connection.getSymbolPrice(instrument);
    const bid = Number(price?.bid);
    const ask = Number(price?.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
      throw new BrokerAdapterError(
        BrokerErrorCode.BROKER_SERVER_ERROR,
        'Broker returned an invalid market quote',
      );
    }

    return {
      instrument,
      bid: this.toDecimalString(bid),
      ask: this.toDecimalString(ask),
      spread: this.toDecimalString(ask - bid),
      timestamp: price.time instanceof Date ? price.time : new Date(price.time ?? Date.now()),
    };
  }

  async getOHLCV(
    accountId: string,
    instrument: string,
    timeframe: string,
    count: number,
  ): Promise<OHLCV[]> {
    // Ensure this exact account has a live pooled connection before reading its
    // account-level historical candle API.
    await this.metaApiClient.getOrCreateConnection(accountId);

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
