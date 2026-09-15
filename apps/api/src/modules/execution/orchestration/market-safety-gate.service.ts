import { Injectable, Logger } from '@nestjs/common';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { BrokerService } from '../../broker/broker.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { OrderService } from '../orders/order.service';
import type { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import type { ExecutionIntent } from './execution-intent.interface';

/**
 * Round 6 live-execution completion (§5/§18) — typed failure codes for the
 * final market-safety gate. When market state cannot be PROVEN, the gate
 * NEVER invents it: every gap is a typed fail-closed rejection that happens
 * BEFORE the provider-dispatch commitment (zero provider calls, the grant
 * is not consumed).
 */
export type MarketSafetyFailureCode =
  /** No provable current quote (market data unavailable / symbol mapping
   *  failed) — never a fabricated price or invented market state (§18). */
  | 'MARKET_DATA_UNAVAILABLE'
  /** The provider quote is older than the execution-freshness window. */
  | 'STALE_PRICE'
  /** The bid/ask spread is abnormally wide relative to the mid price. */
  | 'ABNORMAL_SPREAD'
  /** The current price deviates excessively from the risk-validated
   *  reference price (the market moved materially since sizing/risk). */
  | 'PRICE_DEVIATION_EXCESSIVE';

/** Typed fail-closed market-safety rejection. */
export class MarketSafetyError extends Error {
  constructor(
    readonly code: MarketSafetyFailureCode,
    message: string,
  ) {
    super(`Market safety gate blocked the dispatch [${code}]: ${message}`);
    this.name = 'MarketSafetyError';
  }
}

/** Execution-path quote freshness window (stricter than the 60s display path). */
export const MARKET_QUOTE_MAX_AGE_MS = 30_000;

/** Maximum sane spread as a fraction of the mid price (2% — true-anomaly level). */
export const MARKET_MAX_SPREAD_RATIO = '0.02';

/** Maximum entry-price deviation from the risk-validated reference (1%). */
export const MARKET_MAX_ENTRY_DEVIATION = '0.01';

/**
 * MarketSafetyGateService (Round 6 live-execution completion §5/§18) — the
 * final market-safety gate executed between the order's SUBMITTED mark and
 * the PROVIDER-DISPATCH COMMITMENT.
 *
 * DESIGN CONTRACT
 * ───────────────
 *  - Placement: AFTER the idempotent order reservation, BEFORE the
 *    commitment — a market-safety failure consumes NOTHING (no grant, no
 *    confirmation) and makes ZERO provider state-changing calls; the order
 *    is terminally REJECTED with the typed code.
 *  - Scope: NEW-EXPOSURE PLACE intents only. Risk-REDUCING dispatches
 *    (closes) are deliberately EXEMPT (§10/§17): emergency de-risking and
 *    reconciliation must never be blocked by market anomalies.
 *  - PROVEN market state only (§18): the gate reads ONE fresh provider
 *    quote through the §1a-style tenant/CONNECTED/credential-gated seam.
 *    Unavailable symbol mapping, missing quote or unparseable timestamps
 *    are typed MARKET_DATA_UNAVAILABLE — the gate NEVER invents a market
 *    state, price, or session calendar.
 *  - Freshness is the authoritative market-open signal: a closed market
 *    yields stale/absent provider quotes (the stale check subsumes explicit
 *    session calendars, which the providers do not expose; simulated PAPER
 *    markets are always open by construction).
 *  - ExactDecimal only for every ratio/threshold comparison.
 */
@Injectable()
export class MarketSafetyGateService {
  private readonly logger = new Logger(MarketSafetyGateService.name);

  constructor(
    private readonly brokerService: BrokerService,
    private readonly orderService: OrderService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Assert the market is provably safe for ONE new-exposure dispatch.
   * Throws MarketSafetyError (after terminally rejecting the order) when
   * any check fails — the caller MUST NOT proceed to the commitment.
   */
  async assertMarketSafeForDispatch(
    intent: ExecutionIntent,
    _connection: BrokerConnection,
    orderId: string,
  ): Promise<void> {
    // 1. The provable current quote (§18 — no invention on gaps).
    const quote = await this.brokerService.getCurrentPriceForConnection(
      intent.userId,
      intent.brokerConnectionId,
      intent.instrument,
    );
    if (!quote) {
      await this.rejectForMarketSafety(orderId, intent, 'MARKET_DATA_UNAVAILABLE', (m) =>
        m('no provable current quote for the instrument through this connection'),
      );
      throw new MarketSafetyError('MARKET_DATA_UNAVAILABLE', 'unreachable');
    }

    const observedAt = new Date(quote.timestamp).getTime();
    if (!Number.isFinite(observedAt)) {
      await this.rejectForMarketSafety(orderId, intent, 'MARKET_DATA_UNAVAILABLE', (m) =>
        m('quote timestamp is not a provable instant'),
      );
      throw new MarketSafetyError('MARKET_DATA_UNAVAILABLE', 'unreachable');
    }

    // 2. Freshness (the authoritative market-open signal).
    const age = Math.abs(Date.now() - observedAt);
    if (age > MARKET_QUOTE_MAX_AGE_MS) {
      await this.rejectForMarketSafety(orderId, intent, 'STALE_PRICE', (m) =>
        m(`quote age ${age}ms exceeds the ${MARKET_QUOTE_MAX_AGE_MS}ms execution window`),
      );
    }

    const bid = ExactDecimal.tryParse(quote.bid);
    const ask = ExactDecimal.tryParse(quote.ask);
    const spread = ExactDecimal.tryParse(quote.spread);
    if (!bid || !ask || !bid.isPositive() || !ask.isPositive() || ask.lt(bid)) {
      await this.rejectForMarketSafety(orderId, intent, 'MARKET_DATA_UNAVAILABLE', (m) =>
        m('quote bid/ask are not provable positive decimals with ask >= bid'),
      );
      throw new MarketSafetyError('MARKET_DATA_UNAVAILABLE', 'unreachable');
    }

    // 3. Spread sanity (abnormal-spread anomaly, §18).
    const mid = bid.add(ask).div(ExactDecimal.parse('2'));
    if (spread && mid.isPositive()) {
      const spreadRatio = spread.div(mid, { scale: 10 });
      if (spreadRatio.gt(ExactDecimal.parse(MARKET_MAX_SPREAD_RATIO))) {
        await this.rejectForMarketSafety(orderId, intent, 'ABNORMAL_SPREAD', (m) =>
          m(
            `spread ${spread.toString()} is ${spreadRatio.toFixed(4, 'DOWN')} of mid ` +
              `${mid.toString()} — above the ${MARKET_MAX_SPREAD_RATIO} anomaly threshold`,
          ),
        );
      }
    }

    // 4. Entry deviation vs the risk-validated reference price (§5: the
    //    final gate verifies CURRENT facts — the market must not have moved
    //    materially since the risk evaluation). Runs only when the intent
    //    carries a provable reference.
    const reference = ExactDecimal.tryParse(intent.referencePrice ?? '');
    if (reference && reference.isPositive() && mid.isPositive()) {
      const deviation = mid.sub(reference).abs().div(reference, { scale: 10 });
      if (deviation.gt(ExactDecimal.parse(MARKET_MAX_ENTRY_DEVIATION))) {
        await this.rejectForMarketSafety(orderId, intent, 'PRICE_DEVIATION_EXCESSIVE', (m) =>
          m(
            `mid ${mid.toString()} deviates ${deviation.toFixed(6, 'DOWN')} from the ` +
              `risk-validated reference ${reference.toString()} — above the ` +
              `${MARKET_MAX_ENTRY_DEVIATION} threshold`,
          ),
        );
      }
    }
  }

  /** Terminally reject the order + audit, then surface the typed error. */
  private async rejectForMarketSafety(
    orderId: string,
    intent: ExecutionIntent,
    code: MarketSafetyFailureCode,
    describe: (message: (detail: string) => string) => string,
  ): Promise<never> {
    const detail = describe((d) => d);
    const reason = `MARKET_SAFETY_${code}: ${detail}`;
    this.logger.warn(
      `Market-safety gate rejected order ${orderId} (${intent.instrument} ` +
        `${intent.direction} ${intent.requestedQuantity}): ${reason}`,
    );
    // The order is terminally REJECTED (SUBMITTED → REJECTED is a legal
    // machine transition) — zero provider calls, nothing consumed.
    await this.orderService.rejectOrder(orderId, reason).catch((err) =>
      this.logger.error(
        `Order ${orderId} could not be marked REJECTED after the market-safety ` +
          `failure (${(err as Error).message}) — reconciliation will converge it`,
      ),
    );
    await this.auditService.log({
      actorUserId: intent.userId,
      action: AuditAction.ORDER_REJECTED,
      resourceType: 'Order',
      resourceId: orderId,
      severity: AuditSeverity.WARNING,
      metadata: {
        blockedReason: code,
        clientOrderId: intent.clientOrderId,
        instrument: intent.instrument,
        direction: intent.direction,
        requestedQuantity: intent.requestedQuantity,
        signalId: intent.signalId ?? null,
        tradeId: intent.tradeId ?? null,
        message: reason,
        gate: 'MARKET_SAFETY',
      },
    });
    throw new MarketSafetyError(code, detail);
  }
}
