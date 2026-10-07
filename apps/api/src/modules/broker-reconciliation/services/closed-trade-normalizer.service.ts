import { Injectable, Logger } from '@nestjs/common';
import { BrokerClosedTrade } from '../../broker/interfaces/broker-adapter.interface';
import { NormalizedClosedTrade } from '../interfaces/normalized-closed-trade.interface';
import { getMinorUnitDigits } from './currency-minor-units';

/**
 * Convert a broker major-unit decimal string to a minor-unit bigint string,
 * honouring the currency's ISO 4217 exponent (number of fractional digits).
 *
 * Examples (digits=2): "123.45" → "12345", "-2.50" → "-250", "1000" → "100000"
 * Examples (digits=0): "1000"   → "1000",  "1000.50" → "1000" (yen has no subunit)
 * Examples (digits=3): "1.234"  → "1234"
 *
 * Uses string + BigInt arithmetic only (no floating point), so it is exact for
 * all values representable by a 64-bit integer. Excess fractional digits are
 * truncated toward zero (consistent, never rounds up).
 *
 * Returns null when the input is not a parseable decimal, so callers can
 * distinguish "invalid P&L" from a legitimate zero.
 */
export function majorToMinorUnits(majorStr: string, digits = 2): string | null {
  if (majorStr === null || majorStr === undefined) return null;
  const trimmed = String(majorStr).trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;

  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;

  const dotIdx = abs.indexOf('.');
  let intPart: string;
  let decPart: string;

  if (dotIdx === -1) {
    intPart = abs;
    decPart = '';
  } else {
    intPart = abs.slice(0, dotIdx);
    decPart = abs.slice(dotIdx + 1);
  }

  if (intPart === '') intPart = '0';

  // Validate numeric-only after sign/dot strip — reject anything non-numeric
  if (!/^\d+$/.test(intPart)) return null;
  if (decPart !== '' && !/^\d+$/.test(decPart)) return null;

  // Truncate (or pad) the fractional part to exactly `digits` characters
  const frac = digits === 0 ? '' : decPart.slice(0, digits).padEnd(digits, '0');

  const scale = 10n ** BigInt(digits);
  const minor = BigInt(intPart) * scale + (digits > 0 ? BigInt(frac) : 0n);
  return negative ? (-minor).toString() : minor.toString();
}

/**
 * Validate that a string represents a valid integer (possibly negative).
 * Used to guard minor-unit bigint strings.
 */
export function isValidBigIntString(value: string): boolean {
  return /^-?\d+$/.test(value.trim());
}

/**
 * ClosedTradeNormalizerService
 *
 * Converts raw BrokerClosedTrade records (from IBrokerAdapter.getClosedTrades)
 * into NormalizedClosedTrade objects ready for reconciliation processing.
 *
 * NORMALISATION RULES:
 * 1. brokerTradeId is sourced from externalOrderId — skip if missing.
 * 2. closedAt must be in the past — skip future-dated trades.
 * 3. openedAt is allowed to be null.
 * 4. Money values are converted from major-unit decimal strings to minor-unit
 *    bigint strings (×100 for 2dp currencies). No float arithmetic.
 * 5. netRealisedPnl = grossRealisedPnl + commission + swap.
 *    Do NOT subtract commission/swap a second time when using netRealisedPnl.
 * 6. rawMetadataSummary must NOT include credentials, server URLs, API keys,
 *    account secrets, or full raw broker payloads.
 * 7. Open trades (closedAt missing) are skipped.
 * 8. Trades with invalid numeric P&L are skipped.
 */
@Injectable()
export class ClosedTradeNormalizerService {
  private readonly logger = new Logger(ClosedTradeNormalizerService.name);

  /**
   * Normalize a batch of raw BrokerClosedTrade records.
   * Returns only valid, fully-normalised trades. Invalid trades are logged and skipped.
   *
   * @param rawTrades  Raw trades from IBrokerAdapter.getClosedTrades()
   * @param brokerProvider  Broker identifier string (e.g. "metatrader5")
   * @param now  Current timestamp used for future-closedAt guard
   */
  normalize(
    rawTrades: BrokerClosedTrade[],
    brokerProvider: string,
    currency: string,
    now: Date = new Date(),
  ): { valid: NormalizedClosedTrade[]; skipped: SkippedTrade[] } {
    const valid: NormalizedClosedTrade[] = [];
    const skipped: SkippedTrade[] = [];

    // Resolve the currency exponent once. Throws for unmapped currencies — the
    // reconciliation service validates support upfront, so this is defensive.
    const digits = getMinorUnitDigits(currency);

    for (const raw of rawTrades) {
      const result = this.normalizeOne(raw, brokerProvider, currency, digits, now);
      if (result.kind === 'valid') {
        valid.push(result.trade);
      } else {
        skipped.push(result);
        this.logger.debug(
          `[Normalizer] Skipped trade externalOrderId=${raw.externalOrderId ?? '<none>'}: ${result.reason}`,
        );
      }
    }

    return { valid, skipped };
  }

  private normalizeOne(
    raw: BrokerClosedTrade,
    brokerProvider: string,
    currency: string,
    digits: number,
    now: Date,
  ): { kind: 'valid'; trade: NormalizedClosedTrade } | SkippedTrade {
    // 1. brokerTradeId must be non-empty
    const brokerTradeId = raw.externalOrderId?.trim();
    if (!brokerTradeId) {
      return {
        kind: 'skipped',
        externalOrderId: null,
        reason: 'missing brokerTradeId (externalOrderId)',
      };
    }

    // 2. closedAt must exist and be in the past
    if (!raw.closedAt) {
      return {
        kind: 'skipped',
        externalOrderId: brokerTradeId,
        reason: 'missing closedAt (open trade)',
      };
    }
    if (raw.closedAt > now) {
      return {
        kind: 'skipped',
        externalOrderId: brokerTradeId,
        reason: `future closedAt (${raw.closedAt.toISOString()})`,
      };
    }

    // 3. Convert money to minor units using the currency's exponent.
    //    majorToMinorUnits returns null for non-numeric input → skip as invalid P&L.
    const grossRealisedPnl = majorToMinorUnits(raw.realisedPnl ?? '0', digits);
    const commission = majorToMinorUnits(raw.commission ?? '0', digits);
    const swap = majorToMinorUnits(raw.swap ?? '0', digits);

    if (grossRealisedPnl === null || !isValidBigIntString(grossRealisedPnl)) {
      return {
        kind: 'skipped',
        externalOrderId: brokerTradeId,
        reason: 'invalid grossRealisedPnl',
      };
    }
    if (commission === null || !isValidBigIntString(commission)) {
      return { kind: 'skipped', externalOrderId: brokerTradeId, reason: 'invalid commission' };
    }
    if (swap === null || !isValidBigIntString(swap)) {
      return { kind: 'skipped', externalOrderId: brokerTradeId, reason: 'invalid swap' };
    }

    // 4. Compute net realised P&L (no double-subtraction)
    //    netRealisedPnl = grossRealisedPnl + commission + swap
    const netRealisedPnl = (
      BigInt(grossRealisedPnl) +
      BigInt(commission) +
      BigInt(swap)
    ).toString();

    // 5. Validate direction
    if (raw.direction !== 'BUY' && raw.direction !== 'SELL') {
      return {
        kind: 'skipped',
        externalOrderId: brokerTradeId,
        reason: `invalid direction: ${raw.direction}`,
      };
    }

    // 6. Validate instrument
    if (!raw.instrument?.trim()) {
      return { kind: 'skipped', externalOrderId: brokerTradeId, reason: 'missing instrument' };
    }

    // Safe metadata summary — no credentials, server URLs, or secrets
    const rawMetadataSummary: Record<string, unknown> = {
      brokerProvider,
      instrument: raw.instrument,
      direction: raw.direction,
      lotSize: raw.lotSize,
      closeReason: raw.closeReason,
      openedAt: raw.openedAt?.toISOString() ?? null,
      closedAt: raw.closedAt.toISOString(),
      pathDiagnostics: raw.pathDiagnostics
        ? {
            maxFavorablePnl: raw.pathDiagnostics.maxFavorablePnl,
            maxAdversePnl: raw.pathDiagnostics.maxAdversePnl,
            profitGiveback: raw.pathDiagnostics.profitGiveback,
            observationCount: raw.pathDiagnostics.observationCount,
            sameBarProtectionAmbiguityCount: raw.pathDiagnostics.sameBarProtectionAmbiguityCount,
            lastSameBarProtectionAmbiguityAt:
              raw.pathDiagnostics.lastSameBarProtectionAmbiguityAt?.toISOString() ?? null,
            peakObservedAt: raw.pathDiagnostics.peakObservedAt?.toISOString() ?? null,
            lastObservedAt: raw.pathDiagnostics.lastObservedAt?.toISOString() ?? null,
          }
        : null,
    };

    return {
      kind: 'valid',
      trade: {
        brokerTradeId,
        brokerOrderId: null, // BrokerClosedTrade uses single externalOrderId; no separate order ID
        instrument: raw.instrument.trim(),
        direction: raw.direction,
        volume: raw.lotSize ?? '0',
        openedAt: raw.openedAt ?? null,
        closedAt: raw.closedAt,
        entryPrice: raw.openPrice ?? null,
        exitPrice: raw.closePrice ?? null,
        grossRealisedPnl,
        commission,
        swap,
        netRealisedPnl,
        currency, // resolved from BrokerConnection.accountCurrency at the service layer
        rawMetadataSummary,
      },
    };
  }
}

export interface SkippedTrade {
  kind: 'skipped';
  externalOrderId: string | null;
  reason: string;
}
