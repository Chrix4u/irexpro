import { Injectable, Logger } from '@nestjs/common';
import { ExactDecimal } from '../../common/utils/exact-decimal';
import { BrokerService } from '../broker/broker.service';

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
 *  1. FRESH QUOTE — BrokerService.getCurrentPriceForConnection() is the
 *     connection-scoped execution quote seam. MARKET BUY geometry uses the
 *     executable ASK and MARKET SELL geometry uses the executable BID — never
 *     an M1 candle close, midpoint, cached signal price, or fabricated value.
 *     When the seam fails the caller applies the fail-closed policy.
 *
 *  2. CONTRACT SIZE — resolved through the public connection-scoped
 *     instrument seam BrokerService.getInstrumentSpecForConnection()
 *     (Round 6 live-execution completion: adapters' getInstrumentList()
 *     surfaced with in-process caching, canonical symbols). When the seam
 *     cannot PROVE the specification (unknown symbol, adapter failure,
 *     malformed contract size), resolveOrderGeometry() returns
 *     contractSize = null — the caller treats the geometry as UNVERIFIED:
 *     LIVE NEW exposure fails closed (typed CONTRACT_SIZE_UNAVAILABLE);
 *     PAPER/DEMO records the unverified state honestly in appliedRules
 *     instead of inventing a 100000 fallback. Hardcoding a standard-FX
 *     contract size here would be exactly the "invented pip-value formula"
 *     the architect forbade (metals/CFD instruments report contractSize
 *     '1').
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
   *          fabricated price. contractSize is null when the instrument seam
   *          cannot PROVE the specification (unknown symbol / adapter
   *          failure / malformed value) — never an invented fallback.
   */
  async resolveOrderGeometry(params: {
    userId: string;
    brokerConnectionId: string;
    instrument: string;
    direction: 'BUY' | 'SELL';
    needFreshQuote: boolean;
  }): Promise<{
    contractSize: ExactDecimal | null;
    freshQuote: ExactDecimal | null;
    quoteRef: Record<string, unknown> | null;
    instrumentSpec: import('../broker/interfaces/broker-adapter.interface').BrokerInstrument | null;
  }> {
    let freshQuote: ExactDecimal | null = null;
    let quoteRef: Record<string, unknown> | null = null;

    if (params.needFreshQuote) {
      try {
        const quote = await this.brokerService.getCurrentPriceForConnection(
          params.userId,
          params.brokerConnectionId,
          params.instrument,
        );
        const bid = ExactDecimal.tryParse(quote?.bid ?? '');
        const ask = ExactDecimal.tryParse(quote?.ask ?? '');
        if (bid?.isPositive() && ask?.isPositive() && !ask.lt(bid)) {
          const observedAt = quote?.timestamp instanceof Date ? quote.timestamp : null;
          if (observedAt && Number.isFinite(observedAt.getTime())) {
            freshQuote = params.direction === 'BUY' ? ask : bid;
            quoteRef = {
              instrument: params.instrument,
              direction: params.direction,
              price: freshQuote.toString(),
              bid: bid.toString(),
              ask: ask.toString(),
              observedAt: observedAt.toISOString(),
              source: 'broker-current-price',
            };
          }
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

    // Contract size: PROVEN through the public instrument seam, or null
    // (unverified) — never invented. A seam failure is a typed outcome.
    let contractSize: ExactDecimal | null = null;
    let instrumentSpec:
      | import('../broker/interfaces/broker-adapter.interface').BrokerInstrument
      | null = null;
    try {
      instrumentSpec = await this.brokerService.getInstrumentSpecForConnection(
        params.userId,
        params.brokerConnectionId,
        params.instrument,
      );
      const raw = instrumentSpec?.contractSize;
      const parsed = raw ? ExactDecimal.tryParse(raw) : null;
      contractSize = parsed && parsed.isPositive() ? parsed : null;
      if (instrumentSpec && !contractSize) {
        this.logger.warn(
          `Instrument ${params.instrument} reported a non-positive/malformed contract ` +
            `size ("${raw ?? 'null'}") on connection ${params.brokerConnectionId} — ` +
            'geometry stays UNVERIFIED',
        );
        instrumentSpec = null;
      }
    } catch (err) {
      this.logger.warn(
        `Instrument spec unavailable connection=${params.brokerConnectionId} ` +
          `instrument=${params.instrument}: ${(err as Error).message}`,
      );
    }

    return { contractSize, freshQuote, quoteRef, instrumentSpec };
  }
}
