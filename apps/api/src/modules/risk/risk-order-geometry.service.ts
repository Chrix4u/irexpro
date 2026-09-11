import { Injectable, Logger } from '@nestjs/common';
import { ExactDecimal } from '../../common/utils/exact-decimal';
import { BrokerService } from '../broker/broker.service';
import { OHLCV } from '../broker/interfaces/broker-adapter.interface';

/**
 * RiskOrderGeometryService — resolves the EXACT market geometry a risk
 * boundary comparison needs (Sprint 56 correction round 5, architect issue
 * #316): a fresh connection-scoped quote for MARKET entries and the
 * instrument's contract size for monetary risk-at-stop / notional / effective
 * leverage arithmetic.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SEAM POLICY — existing broker seams ONLY, never invented constants:
 *
 *  1. FRESH QUOTE — the ONLY public connection-scoped market-data seam on
 *     BrokerService is getOhlcvForConnection(). The most recent M1 candle
 *     close is used as the fresh price. No pip-value formula, no cached
 *     signal price substitution, no fabrication when the seam fails — the
 *     caller decides the fail-closed policy (LIVE NEW exposure rejects with
 *     a typed code).
 *
 *  2. CONTRACT SIZE — there is NO public BrokerService seam that exposes
 *     per-instrument contract size today (adapters expose
 *     getInstrumentList()/BrokerInstrument.contractSize, but BrokerService
 *     does not surface it, and the risk engine must not reach into adapter
 *     internals or duplicate credential handling). Until that seam lands,
 *     resolveOrderGeometry() returns contractSize = null — the caller
 *     treats the geometry as UNVERIFIED: LIVE NEW exposure fails closed
 *     (typed CONTRACT_SIZE_UNAVAILABLE); PAPER/DEMO records the unverified
 *     state honestly in appliedRules instead of inventing a 100000
 *     fallback. Hardcoding a standard-FX contract size here would be
 *     exactly the "invented pip-value formula" the architect forbade
 *     (metals/CFD instruments report contractSize '1').
 * ═══════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class RiskOrderGeometryService {
  private readonly logger = new Logger(RiskOrderGeometryService.name);

  constructor(private readonly brokerService: BrokerService) {}

  /**
   * Resolve the geometry for one proposed order.
   *
   * @param needFreshQuote true when the order is a MARKET entry (the signal
   *        carries no usable requested price) — the only case in which a
   *        provider quote fetch is required for the risk boundary.
   * @returns freshQuote is null when unavailable/unparseable — NEVER a
   *          fabricated price. contractSize is null until a broker-side
   *          contract-size seam exists (see class doc).
   */
  async resolveOrderGeometry(params: {
    userId: string;
    brokerConnectionId: string;
    instrument: string;
    needFreshQuote: boolean;
  }): Promise<{
    contractSize: ExactDecimal | null;
    freshQuote: ExactDecimal | null;
    quoteRef: Record<string, unknown> | null;
  }> {
    let freshQuote: ExactDecimal | null = null;
    let quoteRef: Record<string, unknown> | null = null;

    if (params.needFreshQuote) {
      try {
        const candles = await this.brokerService.getOhlcvForConnection(
          params.userId,
          params.brokerConnectionId,
          params.instrument,
          'M1',
          1,
        );
        const last =
          Array.isArray(candles) && candles.length > 0 ? candles[candles.length - 1] : undefined;
        freshQuote = this.parseCandleClose(last);
        if (freshQuote) {
          quoteRef = {
            instrument: params.instrument,
            timeframe: 'M1',
            price: freshQuote.toString(),
            observedAt:
              last?.timestamp instanceof Date
                ? last.timestamp.toISOString()
                : new Date().toISOString(),
            source: 'risk-order-geometry',
          };
        }
      } catch (err) {
        // Unavailable quote is a typed outcome, not an exception — the caller
        // applies the fail-closed policy. Log for observability only.
        this.logger.warn(
          `Fresh quote unavailable connection=${params.brokerConnectionId} ` +
            `instrument=${params.instrument}: ${(err as Error).message}`,
        );
      }
    }

    return { contractSize: null, freshQuote, quoteRef };
  }

  /** Strict-exact parse of a candle close; null on malformed/absent values. */
  private parseCandleClose(candle: OHLCV | undefined): ExactDecimal | null {
    if (!candle) return null;
    const close = candle.close;
    const parsed = ExactDecimal.tryParse(typeof close === 'string' ? close : String(close));
    return parsed && parsed.isPositive() ? parsed : null;
  }
}
