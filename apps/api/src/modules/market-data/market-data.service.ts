import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BrokerService } from '../broker/broker.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { OHLCV } from '../broker/interfaces/broker-adapter.interface';
import { InternalOhlcvQueryDto } from './dto/internal-ohlcv-query.dto';
import { InternalOhlcvResponseDto } from './dto/internal-ohlcv-response.dto';
import { NormalizedOhlcvCandle } from './interfaces/ohlcv-candle.interface';

/**
 * MarketDataService — Internal OHLCV access for the Python AI engine.
 *
 * SECURITY:
 * - Never returns broker credentials or tokens
 * - Never logs decrypted credentials
 * - Only serves CONNECTED broker connections owned by the requesting user
 */
@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  constructor(
    private readonly brokerService: BrokerService,
    private readonly auditService: AuditService,
  ) {}

  async getInternalOhlcv(query: InternalOhlcvQueryDto): Promise<InternalOhlcvResponseDto> {
    const { userId, brokerConnectionId, instrument, timeframe, limit, endTime } = query;

    try {
      const rawCandles = endTime
        ? await this.brokerService.getHistoricalOhlcvForConnection(
            userId,
            brokerConnectionId,
            instrument,
            timeframe,
            new Date(endTime),
            limit,
          )
        : await this.brokerService.getOhlcvForConnection(
            userId,
            brokerConnectionId,
            instrument,
            timeframe,
            limit,
          );

      const candles = rawCandles.map((c) =>
        this.normalizeCandle(c, instrument.toUpperCase(), timeframe.toUpperCase()),
      );

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.MARKET_DATA_REQUESTED,
        resourceType: 'BrokerConnection',
        resourceId: brokerConnectionId,
        metadata: {
          instrument: instrument.toUpperCase(),
          timeframe: timeframe.toUpperCase(),
          limit,
          ...(endTime ? { endTime } : {}),
          count: candles.length,
        },
      });

      return {
        instrument: instrument.toUpperCase(),
        timeframe: timeframe.toUpperCase(),
        source: 'broker',
        count: candles.length,
        candles,
      };
    } catch (err) {
      const message =
        err instanceof ForbiddenException ? err.message : 'Market data temporarily unavailable';

      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.MARKET_DATA_REQUEST_FAILED,
        resourceType: 'BrokerConnection',
        resourceId: brokerConnectionId,
        metadata: {
          instrument: instrument.toUpperCase(),
          timeframe: timeframe.toUpperCase(),
          reason: message,
        },
        severity: AuditSeverity.WARNING,
      });

      this.logger.warn(
        `Internal OHLCV request failed user=${userId} connection=${brokerConnectionId} ` +
          `instrument=${instrument}: ${message}`,
      );

      if (err instanceof ForbiddenException || err instanceof BadRequestException) {
        throw err;
      }

      throw new ServiceUnavailableException({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'Unable to fetch market data from broker at this time',
      });
    }
  }

  private normalizeCandle(
    candle: OHLCV,
    instrument: string,
    timeframe: string,
  ): NormalizedOhlcvCandle {
    const ts =
      candle.timestamp instanceof Date ? candle.timestamp.toISOString() : String(candle.timestamp);

    return {
      timestamp: ts,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      instrument,
      timeframe,
      source: 'broker',
    };
  }
}
