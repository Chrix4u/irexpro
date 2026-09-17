import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { BrokerService } from '../broker/broker.service';
import { CredentialEncryptionService } from '../broker/services/credential-encryption.service';
import { BrokerCredentialLifecycle } from '../broker/authorization/broker-credential-status';
import { AuditService } from '../audit/audit.service';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { MarketIntelligenceQueryDto } from './dto/market-intelligence-query.dto';
import {
  MarketDataFreshness,
  MarketIntelligenceResponseDto,
} from './dto/market-intelligence-response.dto';
import { MetaTraderMarketDataReaderService } from './meta-trader-market-data-reader.service';

const QUOTE_FRESHNESS_MS = 60_000;
const PROVIDER_BACKED_MARKET_BROKER_ID = 'metatrader5';
const PAPER_MARKET_BROKER_ID = 'paper-broker';
const TIMEFRAME_MS: Record<string, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

function toIso(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time)) {
    throw new Error('Invalid market-data timestamp');
  }
  return value.toISOString();
}

function freshness(timestamp: Date, thresholdMs: number, nowMs: number): MarketDataFreshness {
  const ageMs = Math.max(0, nowMs - timestamp.getTime());
  return ageMs <= thresholdMs ? 'FRESH' : 'STALE';
}

/**
 * Authenticated, read-only market projection for trader-facing clients.
 *
 * Real-broker market intelligence remains deliberately provider-backed and is
 * currently restricted to MetaTrader. The built-in DEMO-only paper broker is
 * the single exception: it may expose its own authoritative deterministic
 * simulator quote/OHLCV through the same server-side broker-adapter seams used
 * by the paper execution engine. No browser market values are synthesized and
 * no real/live broker eligibility is widened.
 *
 * MetaTrader reads are account-scoped by the decrypted MetaAPI account
 * reference. Credentials remain in memory only and are cleared in a finally
 * block. Paper reads delegate to BrokerService, which enforces tenant,
 * CONNECTED, credential-lifecycle, and adapter boundaries.
 */
@Injectable()
export class MarketIntelligenceService {
  private readonly logger = new Logger(MarketIntelligenceService.name);

  constructor(
    private readonly brokerService: BrokerService,
    private readonly marketDataReader: MetaTraderMarketDataReaderService,
    private readonly encryptionService: CredentialEncryptionService,
    private readonly auditService: AuditService,
  ) {}

  async getSnapshot(
    userId: string,
    query: MarketIntelligenceQueryDto,
  ): Promise<MarketIntelligenceResponseDto> {
    const instrument = query.instrument.toUpperCase();
    const timeframe = query.timeframe.toUpperCase();
    const connection = await this.brokerService.findActiveConnectionForUser(userId);

    if (!connection) {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'Market data requires an active broker connection',
      });
    }

    if (connection.brokerId === PAPER_MARKET_BROKER_ID) {
      if (connection.accountType !== 'DEMO') {
        throw new ServiceUnavailableException({
          code: 'MARKET_DATA_UNAVAILABLE',
          message: 'Paper market data is available only for DEMO connections',
        });
      }

      try {
        // Deliberately sequential. The paper quote advances the deterministic
        // simulator by one tick; candles then anchor to that same simulator
        // clock. Both reads remain server-side and connection-scoped.
        const quote = await this.brokerService.getCurrentPriceForConnection(
          userId,
          connection.id,
          instrument,
        );
        if (!quote) {
          throw new Error('Paper broker returned no verifiable quote');
        }
        const rawCandles = await this.brokerService.getOhlcvForConnection(
          userId,
          connection.id,
          instrument,
          timeframe,
          query.limit,
        );

        return await this.buildSnapshot(
          userId,
          connection.id,
          instrument,
          timeframe,
          query.limit,
          quote,
          rawCandles,
        );
      } catch {
        await this.auditFailure(
          userId,
          connection.id,
          instrument,
          timeframe,
          'simulator-unavailable',
        );
        this.logger.warn(
          `Paper market-data request failed user=${userId} instrument=${instrument} timeframe=${timeframe}`,
        );
        throw new ServiceUnavailableException({
          code: 'MARKET_DATA_UNAVAILABLE',
          message: 'Unable to fetch paper market data at this time',
        });
      }
    }

    if (connection.brokerId !== PROVIDER_BACKED_MARKET_BROKER_ID) {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'Live market data requires a provider-backed broker connection',
      });
    }

    if (!connection.encryptedCredentials || !connection.credentialIv || !connection.credentialTag) {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'Live market data requires an active broker connection',
      });
    }

    // A3 (architect correction): credential-lifecycle gate before decrypt —
    // unusable credential states never produce a provider-backed read.
    if (!BrokerCredentialLifecycle.isUsable(connection.credentialStatus)) {
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'Broker credentials are not usable for market data reads (fail-closed)',
      });
    }

    const credentials = this.encryptionService.decrypt({
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
      keyId: connection.encryptionKeyId ?? 'env-key-v1',
    });

    try {
      const [quote, rawCandles] = await Promise.all([
        this.marketDataReader.getCurrentPrice(credentials.accountId, instrument),
        this.marketDataReader.getOHLCV(credentials.accountId, instrument, timeframe, query.limit),
      ]);

      return await this.buildSnapshot(
        userId,
        connection.id,
        instrument,
        timeframe,
        query.limit,
        quote,
        rawCandles,
      );
    } catch {
      await this.auditFailure(userId, connection.id, instrument, timeframe, 'provider-unavailable');
      this.logger.warn(
        `Trader market-data request failed user=${userId} instrument=${instrument} timeframe=${timeframe}`,
      );
      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'Unable to fetch live market data from broker at this time',
      });
    } finally {
      Object.keys(credentials).forEach((key) => {
        (credentials as unknown as Record<string, unknown>)[key] = null;
      });
    }
  }

  private async buildSnapshot(
    userId: string,
    connectionId: string,
    instrument: string,
    timeframe: string,
    limit: number,
    quote: {
      bid: string;
      ask: string;
      spread: string;
      timestamp: Date;
    },
    rawCandles: Array<{
      timestamp: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>,
  ): Promise<MarketIntelligenceResponseDto> {
    const candles = rawCandles
      .map((candle) => ({
        timestamp: toIso(candle.timestamp),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    if (candles.length === 0) {
      throw new Error('Broker returned no candles');
    }

    const nowMs = Date.now();
    const quoteFreshness = freshness(quote.timestamp, QUOTE_FRESHNESS_MS, nowMs);
    const latestCandleAt = new Date(candles[candles.length - 1].timestamp);
    const candleFreshness = freshness(
      latestCandleAt,
      (TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS.H1) * 2,
      nowMs,
    );
    const status: MarketDataFreshness =
      quoteFreshness === 'FRESH' && candleFreshness === 'FRESH' ? 'FRESH' : 'STALE';

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.MARKET_DATA_REQUESTED,
      resourceType: 'BrokerConnection',
      resourceId: connectionId,
      metadata: {
        instrument,
        timeframe,
        limit,
        count: candles.length,
        status,
      },
    });

    return {
      instrument,
      timeframe,
      source: 'BROKER',
      status,
      retrievedAt: new Date(nowMs).toISOString(),
      latestCandleAt: latestCandleAt.toISOString(),
      quote: {
        bid: quote.bid,
        ask: quote.ask,
        spread: quote.spread,
        timestamp: toIso(quote.timestamp),
        freshness: quoteFreshness,
      },
      candles,
    };
  }

  private async auditFailure(
    userId: string,
    connectionId: string,
    instrument: string,
    timeframe: string,
    reason: 'provider-unavailable' | 'simulator-unavailable',
  ): Promise<void> {
    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.MARKET_DATA_REQUEST_FAILED,
      resourceType: 'BrokerConnection',
      resourceId: connectionId,
      metadata: { instrument, timeframe, reason },
      severity: AuditSeverity.WARNING,
    });
  }
}
