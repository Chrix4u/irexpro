import { Injectable } from '@nestjs/common';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { ProviderQuoteCandleStoreService } from './provider-quote-candle-store.service';

export type BrokerFxConversionSource =
  | 'BROKER_NATIVE_CACHE_DIRECT'
  | 'BROKER_NATIVE_CACHE_INVERSE'
  | 'BROKER_NATIVE_CACHE_USD_BRIDGE';

export interface BrokerFxConversionEvidence {
  rate: string;
  path: string[];
  source: BrokerFxConversionSource;
  observedAt: Date;
}

interface ResolvedLeg {
  rate: ExactDecimal;
  instrument: string;
  observedAt: Date;
  inverted: boolean;
}

const DEFAULT_MAX_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;

@Injectable()
export class BrokerFxConversionService {
  constructor(private readonly store: ProviderQuoteCandleStoreService) {}

  async resolveCachedBid(
    connectionId: string,
    accountCurrency: string,
    quoteCurrency: string,
    evaluatedAt = new Date(),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  ): Promise<BrokerFxConversionEvidence | null> {
    const account = accountCurrency.trim().toUpperCase();
    const quote = quoteCurrency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(account) || !/^[A-Z]{3}$/.test(quote)) return null;
    if (account === quote) {
      return {
        rate: '1',
        path: [],
        source: 'BROKER_NATIVE_CACHE_DIRECT',
        observedAt: new Date(evaluatedAt),
      };
    }

    const direct = await this.resolveLeg(connectionId, account, quote, evaluatedAt, maxAgeMs);
    if (direct) {
      return {
        rate: direct.rate.toString(),
        path: [direct.instrument],
        source: direct.inverted
          ? 'BROKER_NATIVE_CACHE_INVERSE'
          : 'BROKER_NATIVE_CACHE_DIRECT',
        observedAt: direct.observedAt,
      };
    }

    if (account === 'USD' || quote === 'USD') return null;

    const accountToUsd = await this.resolveLeg(
      connectionId,
      account,
      'USD',
      evaluatedAt,
      maxAgeMs,
    );
    if (!accountToUsd) return null;
    const usdToQuote = await this.resolveLeg(
      connectionId,
      'USD',
      quote,
      evaluatedAt,
      maxAgeMs,
    );
    if (!usdToQuote) return null;

    return {
      rate: accountToUsd.rate.mul(usdToQuote.rate).toString(),
      path: [accountToUsd.instrument, usdToQuote.instrument],
      source: 'BROKER_NATIVE_CACHE_USD_BRIDGE',
      observedAt: new Date(
        Math.min(accountToUsd.observedAt.getTime(), usdToQuote.observedAt.getTime()),
      ),
    };
  }

  private async resolveLeg(
    connectionId: string,
    baseCurrency: string,
    quoteCurrency: string,
    evaluatedAt: Date,
    maxAgeMs: number,
  ): Promise<ResolvedLeg | null> {
    const directInstrument = `${baseCurrency}${quoteCurrency}`;
    const direct = await this.store.getLatestPositiveSpreadQuote(
      connectionId,
      directInstrument,
      evaluatedAt,
    );
    if (this.isFreshQuote(direct, evaluatedAt, maxAgeMs)) {
      const bid = ExactDecimal.tryParse(direct!.bid);
      if (bid?.isPositive()) {
        return {
          rate: bid,
          instrument: directInstrument,
          observedAt: new Date(direct!.timestamp),
          inverted: false,
        };
      }
    }

    const inverseInstrument = `${quoteCurrency}${baseCurrency}`;
    const inverse = await this.store.getLatestPositiveSpreadQuote(
      connectionId,
      inverseInstrument,
      evaluatedAt,
    );
    if (!this.isFreshQuote(inverse, evaluatedAt, maxAgeMs)) return null;
    const inverseAsk = ExactDecimal.tryParse(inverse!.ask);
    if (!inverseAsk?.isPositive()) return null;

    return {
      // Conservative bid for BASE/QUOTE from the inverse pair is 1 / inverse ASK.
      rate: ExactDecimal.ONE.divDown(inverseAsk, 12),
      instrument: inverseInstrument,
      observedAt: new Date(inverse!.timestamp),
      inverted: true,
    };
  }

  private isFreshQuote(
    quote:
      | {
          bid: string;
          ask: string;
          timestamp: Date;
        }
      | null,
    evaluatedAt: Date,
    maxAgeMs: number,
  ): boolean {
    if (!quote) return false;
    const bid = ExactDecimal.tryParse(quote.bid);
    const ask = ExactDecimal.tryParse(quote.ask);
    const timestamp = new Date(quote.timestamp).getTime();
    const evaluatedAtMs = evaluatedAt.getTime();
    if (!bid?.isPositive() || !ask?.isPositive() || ask.lt(bid)) return false;
    if (!Number.isFinite(timestamp) || !Number.isFinite(evaluatedAtMs)) return false;
    const ageMs = evaluatedAtMs - timestamp;
    return ageMs >= -MAX_FUTURE_SKEW_MS && ageMs <= maxAgeMs;
  }
}
