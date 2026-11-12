import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { RiskProfile } from '../../risk/entities/risk-profile.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerFxConversionService } from '../../market-data/services/broker-fx-conversion.service';
import { RiskOrderGeometryService } from '../../risk/risk-order-geometry.service';
import {
  paperAllocationSizingPolicy,
  type PaperAllocationConfidenceTier,
} from './paper-allocation-sizing-policy';
import { drawdownRiskAdjustment } from './drawdown-risk-scaling';

/**
 * Round 6 live-execution completion (§4) — typed failure codes for the
 * position-sizing engine. Missing or unprovable inputs NEVER produce a
 * guessed volume: every gap is a typed fail-closed rejection.
 */
export type PositionSizingFailureCode =
  /** Authoritative account state (equity/free margin) missing or partial (§1c). */
  | 'EQUITY_UNPROVABLE'
  | 'FREE_MARGIN_UNPROVABLE'
  | 'ACCOUNT_CURRENCY_UNPROVABLE'
  /** Instrument specification (min/max/step/contract size) unprovable. */
  | 'INSTRUMENT_SPEC_UNPROVABLE'
  | 'CONTRACT_SIZE_UNPROVABLE'
  /** Protective/reference price inputs unprovable. */
  | 'STOP_LOSS_REQUIRED'
  | 'STOP_LOSS_UNPARSEABLE'
  | 'STOP_LOSS_DISTANCE_INVALID'
  | 'ENTRY_PRICE_UNPROVABLE'
  | 'ENTRY_PRICE_UNPARSEABLE'
  /** Sizing policy inputs unprovable. */
  | 'RISK_PROFILE_UNPROVABLE'
  | 'RISK_BUDGET_UNPARSEABLE'
  /** The broker cannot prove the capital/margin required by the final sized volume. */
  | 'REQUIRED_MARGIN_UNPROVABLE'
  /** The account-to-quote conversion cannot be proven. Cross-currency sizing
   * is allowed only with a fresh quote from the exact connected broker. */
  | 'CURRENCY_MISMATCH'
  /** The risk budget cannot afford the instrument's minimum volume —
   * rounding UP to minLot would EXCEED the risk budget, so it is a
   * rejection, never a round-up. */
  | 'POSITION_SIZE_BELOW_MINIMUM'
  | 'POSITION_SIZE_BELOW_POLICY_MINIMUM'
  | 'BROKER_MINIMUM_MARGIN_UNAFFORDABLE'
  | 'POLICY_MINIMUM_LOT_UNPROVABLE'
  | 'POSITION_SIZE_ZERO';

/** Typed fail-closed sizing rejection — carries the stable machine code. */
export class PositionSizingError extends Error {
  constructor(
    readonly code: PositionSizingFailureCode,
    message: string,
  ) {
    super(`Position sizing failed closed [${code}]: ${message}`);
    this.name = 'PositionSizingError';
  }
}

/** The §4 reconstruction record — persisted with every allocation. */
export interface PositionSizingInputs {
  accountCurrency: string;
  equity: string;
  freeMargin: string;
  riskPercent: string;
  requestedRiskPercent: string;
  baseRiskPercent: string;
  adaptiveRiskMultiplier: string;
  adaptiveRiskPercent: string;
  sessionPeakEquity: string | null;
  currentDrawdownPercent: string | null;
  maxDrawdownPercent: string | null;
  drawdownRiskMultiplier: string;
  combinedRiskMultiplier: string;
  drawdownAdjustedRiskPercent: string;
  riskCapitalBase: string;
  allocationAwarePaper: boolean;
  /** Entry reference used to derive stop risk. PAPER MARKET may preserve the model distance. */
  riskReferenceEntryPrice?: string;
  baseRiskAmount: string;
  riskAmount: string;
  baseCurrency: string;
  quoteCurrency: string;
  riskAmountInQuoteCurrency: string;
  riskCurrencyConversion:
    | 'ACCOUNT_IS_QUOTE'
    | 'ACCOUNT_IS_BASE_USING_ENTRY'
    | 'ACCOUNT_TO_QUOTE_USING_BROKER_BID'
    | 'ACCOUNT_TO_QUOTE_USING_BROKER_NATIVE_EVIDENCE';
  /** Exact FX pair/rate used when a third-currency account needs conversion evidence. */
  riskCurrencyConversionInstrument?: string | null;
  riskCurrencyConversionRate?: string | null;
  entryPrice: string;
  entryPriceSource: 'MARKET_QUOTE' | 'REQUESTED_LIMIT';
  stopLoss: string;
  stopLossDistance: string;
  contractSize: string;
  minLot: string;
  policyMinimumExecutableLot?: string | null;
  policyMinimumLotLifted?: boolean;
  /** 0.20 lot is a target, NOT a product minimum. */
  preferredLotTarget?: string | null;
  /** Audit why the actual lot is lower than the requested preferred target. */
  lotSelectionReason?:
    | 'PREFERRED_LOT_ACHIEVED'
    | 'BROKER_RISK_SCALED_DOWN'
    | 'STANDARD_RISK_SIZING';
  /** Portion of proven margin capacity reserved for micro accounts. */
  microAccountMarginReservePercent?: string | null;
  finalRiskAtStop?: string;
  finalRiskAtStopPercentOfCapital?: string;
  /** Pepperstone DEMO scoped, decision-time conservative risk projection. Never a guaranteed fill/SL cap. */
  demoExecutionRiskEnvelope?: {
    artifact: 'pepperstone-demo-cost-aware-risk-sizing-v1';
    originalLots: string;
    initialGrossStopRisk: string;
    adjustedLots: string;
    modelStopDistance: string;
    observedSpread: string;
    spreadReserveMultiple: 2;
    historicalFeePerLot: string | null;
    historicalFeeSamples: number;
    feeSource: 'SAME_SYMBOL' | 'SAME_ACCOUNT_FX_MAJORS' | 'UNAVAILABLE';
    conservativeEstimatedStopRisk: string;
    commissionIncluded: boolean;
    isGuaranteedMaximumLoss: false;
  };
  maxLot: string;
  lotStep: string;
  profileMaxPositionSizeLot: string;
  maxLeverageAllowed: string;
  lotsByLeverageCeiling: string;
  notionalPerLotAccountCurrency: string;
  finalNotionalAccountCurrency: string;
  finalEffectiveLeverage: string;
  requestedLotUpperBound: string;
  effectiveRequestedLotUpperBound?: string;
  paperProductMinimumLot?: string | null;
  paperProductMaximumLot?: string | null;
  lotsByRiskBudget: string;
  lotsBeforeStepNormalization: string;
  grossNotional: string;
  requiredMargin: string;
  computedAt: string;
}

/** The sized result handed to the allocation engine + risk gate. */
export interface SizedPosition {
  lots: string;
  allocatedCapital: string;
  accountCurrency: string;
  entryPrice: string;
  inputs: PositionSizingInputs;
}

/** Decimal scale for lot math (lot steps are 0.01/0.001 — 8 digits is exact). */
const LOT_SCALE = 8;
/** Preferred professional DEMO trade size when independently affordable. */
export const PAPER_PRODUCT_PREFERRED_LOT = '0.2';
/** Compatibility alias; historically a hard minimum, now preference only. */
export const PAPER_PRODUCT_ABSOLUTE_MIN_LOT = PAPER_PRODUCT_PREFERRED_LOT;
const PAPER_PRODUCT_DEFAULT_MIN_LOT = '0.2';
/** Only an exposure pre-screen floor; the instrument's real min/step remains authoritative. */
export const PAPER_BROKER_AWARE_EXPOSURE_SEARCH_FLOOR = '0.001';
/** Reserve headroom for slippage/commission on a tiny broker account. */
const MICRO_EQUITY_THRESHOLD = ExactDecimal.parse('50');
const MICRO_MARGIN_CAPACITY_MULTIPLIER = ExactDecimal.parse('0.8');
const PAPER_PRODUCT_MAX_LOT = '4';

/**
 * PositionSizingService (Round 6 live-execution completion §4) — the
 * deterministic, fail-closed position-sizing engine.
 *
 * DESIGN CONTRACT
 * ───────────────
 *  - EVERY input is PROVEN or the sizing fails with a typed code: equity/
 *    free margin from the AUTHORITATIVE account snapshot (§1a routing —
 *    never a cache/legacy row), instrument constraints from the §1a
 *    instrument seam, entry reference from the risk-geometry quote (MARKET)
 *    or the decision's requested price (LIMIT), risk budget from the
 *    durable risk profile. NO input is guessed, defaulted or approximated.
 *  - ALL arithmetic is ExactDecimal — JavaScript floating-point is never
 *    used for sizing math (§3/§4).
 *  - lots = min(risk-budget lots, profile max position, instrument max
 *    lot), normalized DOWN to the instrument's volume step. Rounding DOWN
 *    is the conservative direction for risk; rounding UP to minLot would
 *    exceed the risk budget, so a below-minimum result is a typed rejection.
 *  - Currency honesty: stop risk is computed in the instrument's QUOTE
 *    currency. If the account uses a third currency, conversion is permitted
 *    only from a fresh quote on the exact connected broker; otherwise sizing
 *    fails closed with CURRENCY_MISMATCH.
 *  - The AI capital-allocation ledger reserves broker-required margin/capital
 *    consumption, NOT gross leveraged FX notional. The broker adapter is the
 *    authority for required margin because leverage/margin rules vary by
 *    provider and instrument. RiskService independently re-validates current
 *    free margin later at the execution gate (defense in depth).
 *  - The FULL input + intermediate record is returned for persistence
 *    (§4: inputs/results reconstructable).
 */
@Injectable()
export class PositionSizingService {
  private readonly logger = new Logger(PositionSizingService.name);

  constructor(
    private readonly brokerService: BrokerService,
    private readonly orderGeometry: RiskOrderGeometryService,
    @InjectRepository(RiskProfile)
    private readonly profileRepo: Repository<RiskProfile>,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private get brokerFxConversion(): BrokerFxConversionService | null {
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get(BrokerFxConversionService, { strict: false });
    } catch {
      return null;
    }
  }

  /** Strictly as-of historical broker costs; never use future fills or guessed tariffs. */
  private async loadPepperstoneDemoHistoricalFeePerLot(input: {
    userId: string;
    brokerConnectionId: string;
    accountCurrency: string;
    instrument: string;
    asOf: Date;
  }): Promise<{
    feePerLot: string;
    sampleCount: number;
    source: 'SAME_SYMBOL' | 'SAME_ACCOUNT_FX_MAJORS';
  } | null> {
    let db: DataSource | null = null;
    try { db = this.moduleRef?.get(DataSource, { strict: false }) ?? null; }
    catch { return null; }
    if (!db) return null;
    for (const sameSymbol of [true, false]) {
      try {
        const rows = (await db.query(
          `SELECT COUNT(*)::int sample_count,
                  percentile_cont(0.9) WITHIN GROUP (ORDER BY fee_per_lot) p90_fee_per_lot
             FROM (
               SELECT (ABS(commission) + GREATEST(0, -COALESCE(swap,0))) /
                      NULLIF(lot_size,0) fee_per_lot
               FROM trading.trades
               WHERE user_id=$1 AND broker_connection_id=$2 AND account_currency=$3
                 AND status='CLOSED' AND commission IS NOT NULL AND lot_size>0
                 AND closed_at < $4::timestamptz
                 AND closed_at >= $4::timestamptz - interval '21 days'
                 AND (CASE WHEN $5::boolean THEN instrument=$6
                      ELSE instrument=ANY(ARRAY['EURUSD','AUDUSD','GBPUSD',
                                                'USDCAD','USDCHF','USDJPY']) END)
               ORDER BY closed_at DESC LIMIT 40
             ) historical`,
          [input.userId,input.brokerConnectionId,input.accountCurrency,
           input.asOf.toISOString(),sameSymbol,input.instrument],
        )) as Array<{sample_count:string|number;p90_fee_per_lot:string|number|null}>;
        const samples = Number(rows[0]?.sample_count ?? 0);
        const fee = ExactDecimal.tryParse(String(rows[0]?.p90_fee_per_lot ?? ''));
        if (samples >= (sameSymbol ? 5 : 8) && fee?.isPositive()) {
          return {
            feePerLot: fee.toString(), sampleCount: samples,
            source: sameSymbol ? 'SAME_SYMBOL' : 'SAME_ACCOUNT_FX_MAJORS',
          };
        }
      } catch {
        // Cost evidence is optional for this size-only pilot. Never replace
        // unavailable broker fees with a guessed zero-cost claim.
        return null;
      }
    }
    return null;
  }

  /**
   * Size ONE trade decision.
   *
   * @param params.instrument canonical instrument symbol
   * @param params.entryType  MARKET (fresh quote required) | LIMIT
   *         (requestedEntryPrice is the reference)
   * @param params.stopLoss   mandatory protective stop (risk anchor)
   */
  async sizePosition(params: {
    userId: string;
    brokerConnectionId: string;
    instrument: string;
    direction: 'BUY' | 'SELL';
    entryType: 'MARKET' | 'LIMIT';
    requestedEntryPrice: string | null;
    stopLoss: string | null;
    requestedLotUpperBound: string;
    strategyTimeframe?: string;
    paperAllocationSizing?: {
      executionMode: string;
      allocatedCapital: string | null;
      confidenceTier: PaperAllocationConfidenceTier;
      /** Closed-bar/model entry used only to preserve PAPER MARKET risk distance. */
      marketReferenceEntryPrice?: string | null;
      /** PAPER-only intelligence multiplier; ignored outside allocation-aware PAPER. */
      adaptiveRiskMultiplier?: string | null;
      /** Session peak equity used only to reduce risk before the hard drawdown boundary. */
      sessionPeakEquity?: string | null;
      /** PAPER-only preferred lot. Never a hard floor; broker min/step and account risk/margin govern. */
      minimumExecutableLot?: string | null;
    };
  }): Promise<SizedPosition> {
    const { userId, brokerConnectionId, instrument } = params;

    // ── 1. Authoritative account state (§1a snapshot routing; DB-only). ──
    const account = await this.brokerService.getBrokerAccountState(brokerConnectionId);
    if (!account) {
      throw new PositionSizingError(
        'EQUITY_UNPROVABLE',
        `no authoritative broker-account snapshot for connection ${brokerConnectionId}`,
      );
    }
    const equity = ExactDecimal.tryParse(account.equity);
    if (!equity || !equity.isPositive()) {
      throw new PositionSizingError(
        'EQUITY_UNPROVABLE',
        `account equity is not a provable positive decimal: ${account.equity}`,
      );
    }
    const freeMargin = ExactDecimal.tryParse(account.freeMargin);
    if (!freeMargin) {
      throw new PositionSizingError(
        'FREE_MARGIN_UNPROVABLE',
        `account free margin is not a provable decimal: ${account.freeMargin}`,
      );
    }
    const accountCurrency = account.currency?.toUpperCase() ?? '';
    if (!/^[A-Z]{3}$/.test(accountCurrency)) {
      throw new PositionSizingError(
        'ACCOUNT_CURRENCY_UNPROVABLE',
        `account currency is not a provable ISO-4217 code: ${account.currency}`,
      );
    }

    // ── 2. Risk budget from the durable profile (never defaulted). ────────
    const profile = await this.profileRepo.findOne({ where: { userId } });
    if (!profile) {
      throw new PositionSizingError(
        'RISK_PROFILE_UNPROVABLE',
        `no risk profile for user ${userId}`,
      );
    }
    const riskPercent = ExactDecimal.tryParse(profile.maxTradeRiskPercent);
    if (!riskPercent || !riskPercent.isPositive()) {
      throw new PositionSizingError(
        'RISK_BUDGET_UNPARSEABLE',
        `profile maxTradeRiskPercent is not a provable positive decimal: ${profile.maxTradeRiskPercent}`,
      );
    }
    const profileMaxLots = ExactDecimal.tryParse(profile.maxPositionSizeLot);
    if (!profileMaxLots || !profileMaxLots.isPositive()) {
      throw new PositionSizingError(
        'RISK_BUDGET_UNPARSEABLE',
        `profile maxPositionSizeLot is not a provable positive decimal: ${profile.maxPositionSizeLot}`,
      );
    }

    const maxLeverageAllowed = ExactDecimal.tryParse(String(profile.maxLeverageAllowed));
    if (!maxLeverageAllowed || !maxLeverageAllowed.isPositive()) {
      throw new PositionSizingError(
        'RISK_BUDGET_UNPARSEABLE',
        `profile maxLeverageAllowed is not a provable positive decimal: ${profile.maxLeverageAllowed}`,
      );
    }

    let effectiveRiskPercent = riskPercent;
    let requestedRiskPercent = riskPercent;
    let riskCapitalBase = equity;
    let allocationAwarePaper = false;
    let paperBrokerId: string | null = null;
    let paperBrokerAccountType: string | null = null;
    let removeAiLotCeiling = false;
    let removeProfileLotCeiling = false;

    if (params.paperAllocationSizing) {
      let brokerAccountType: string | null = null;
      try {
        const connection = await this.brokerService.findConnectionById(
          params.brokerConnectionId,
          userId,
        );
        brokerAccountType = connection.accountType;
        paperBrokerId = connection.brokerId;
        paperBrokerAccountType = connection.accountType;
      } catch {
        // Environment is authorization evidence. If it cannot be proven, the
        // allocation-aware override stays disabled and legacy risk ceilings remain.
        brokerAccountType = null;
      }
      const allocatedCapital = ExactDecimal.tryParse(
        params.paperAllocationSizing.allocatedCapital ?? '',
      );
      const policy = paperAllocationSizingPolicy({
        executionMode: params.paperAllocationSizing.executionMode,
        brokerAccountType,
        allocatedCapital: allocatedCapital ? Number(allocatedCapital.toString()) : null,
        brokerEquity: Number(equity.toString()),
        confidenceTier: params.paperAllocationSizing.confidenceTier,
      });

      if (policy.enabled && allocatedCapital?.isPositive()) {
        const requested = ExactDecimal.parse(String(policy.requestedRiskPercent));
        allocationAwarePaper = true;
        requestedRiskPercent = requested;
        effectiveRiskPercent = ExactDecimal.min(requested, riskPercent);
        riskCapitalBase = ExactDecimal.min(allocatedCapital, equity);
        removeAiLotCeiling = policy.removeAiLotCeiling;
        removeProfileLotCeiling = policy.removeProfileLotCeiling;
      }
    }

    const baseRiskPercent = effectiveRiskPercent;
    let adaptiveRiskMultiplier = ExactDecimal.ONE;
    if (allocationAwarePaper && params.paperAllocationSizing?.adaptiveRiskMultiplier != null) {
      const requestedAdaptiveMultiplier = ExactDecimal.tryParse(
        params.paperAllocationSizing.adaptiveRiskMultiplier,
      );
      const minimumAdaptiveMultiplier = ExactDecimal.parse('0.5');
      const maximumAdaptiveMultiplier = ExactDecimal.parse('1.25');
      if (
        !requestedAdaptiveMultiplier ||
        requestedAdaptiveMultiplier.lt(minimumAdaptiveMultiplier) ||
        requestedAdaptiveMultiplier.gt(maximumAdaptiveMultiplier)
      ) {
        throw new PositionSizingError(
          'RISK_BUDGET_UNPARSEABLE',
          `adaptive PAPER risk multiplier must be between 0.50 and 1.25: ${params.paperAllocationSizing.adaptiveRiskMultiplier}`,
        );
      }
      const routeMultiplierCeiling =
        params.paperAllocationSizing.confidenceTier === 'RESEARCH'
          ? ExactDecimal.ONE
          : maximumAdaptiveMultiplier;
      adaptiveRiskMultiplier = ExactDecimal.min(
        requestedAdaptiveMultiplier,
        routeMultiplierCeiling,
      );
      effectiveRiskPercent = ExactDecimal.min(
        baseRiskPercent.mul(adaptiveRiskMultiplier),
        riskPercent,
      );
    }
    const adaptiveRiskPercent = effectiveRiskPercent;
    const drawdownAdjustment = allocationAwarePaper
      ? drawdownRiskAdjustment({
          equity,
          sessionPeakEquity: params.paperAllocationSizing?.sessionPeakEquity,
          maxDrawdownPercent: profile.maxDrawdownPercent,
        })
      : {
          currentDrawdownPercent: null,
          maxDrawdownPercent: null,
          multiplier: '1' as const,
        };
    const drawdownRiskMultiplier = ExactDecimal.parse(drawdownAdjustment.multiplier);
    effectiveRiskPercent = adaptiveRiskPercent.mul(drawdownRiskMultiplier);
    const drawdownAdjustedRiskPercent = effectiveRiskPercent;
    const combinedRiskMultiplier = drawdownAdjustedRiskPercent.divDown(baseRiskPercent, 8);

    // ── 3. Geometry: entry reference + PROVEN contract size (§1a seam). ───
    const geometry = await this.orderGeometry.resolveOrderGeometry({
      userId,
      brokerConnectionId,
      instrument,
      direction: params.direction,
      needFreshQuote: params.entryType === 'MARKET',
      strategyTimeframe: params.strategyTimeframe,
    });
    const contractSize =
      geometry.contractSize ??
      (geometry.instrumentSpec
        ? ExactDecimal.tryParse(geometry.instrumentSpec.contractSize)
        : null);
    if (!contractSize || !contractSize.isPositive()) {
      throw new PositionSizingError(
        'CONTRACT_SIZE_UNPROVABLE',
        `contract size for ${instrument} cannot be proven through the instrument seam`,
      );
    }

    let entry: ExactDecimal;
    let entryPriceSource: 'MARKET_QUOTE' | 'REQUESTED_LIMIT';
    if (params.entryType === 'LIMIT') {
      const requested = ExactDecimal.tryParse(params.requestedEntryPrice ?? '');
      if (!requested || !requested.isPositive()) {
        throw new PositionSizingError(
          'ENTRY_PRICE_UNPARSEABLE',
          `LIMIT entry requested price is not a provable positive decimal: ${params.requestedEntryPrice}`,
        );
      }
      entry = requested;
      entryPriceSource = 'REQUESTED_LIMIT';
    } else {
      if (!geometry.freshQuote || !geometry.freshQuote.isPositive()) {
        throw new PositionSizingError(
          'ENTRY_PRICE_UNPROVABLE',
          `no provable fresh quote for MARKET entry on ${instrument}`,
        );
      }
      entry = geometry.freshQuote;
      entryPriceSource = 'MARKET_QUOTE';
    }

    // ── 4. Stop-loss anchor (mandatory — the risk distance). ──────────────
    if (params.stopLoss === null || params.stopLoss === undefined) {
      throw new PositionSizingError(
        'STOP_LOSS_REQUIRED',
        'position sizing requires a stop loss (risk-distance anchor)',
      );
    }
    const stopLoss = ExactDecimal.tryParse(params.stopLoss);
    if (!stopLoss || !stopLoss.isPositive()) {
      throw new PositionSizingError(
        'STOP_LOSS_UNPARSEABLE',
        `stop loss is not a provable positive decimal: ${params.stopLoss}`,
      );
    }
    let riskReferenceEntry = entry;
    if (
      allocationAwarePaper &&
      params.entryType === 'MARKET' &&
      params.paperAllocationSizing?.marketReferenceEntryPrice != null
    ) {
      const modelReference = ExactDecimal.tryParse(
        params.paperAllocationSizing.marketReferenceEntryPrice,
      );
      if (!modelReference || !modelReference.isPositive()) {
        throw new PositionSizingError(
          'ENTRY_PRICE_UNPARSEABLE',
          `PAPER MARKET reference entry is not a provable positive decimal: ${params.paperAllocationSizing.marketReferenceEntryPrice}`,
        );
      }
      riskReferenceEntry = modelReference;
    }

    // For allocation-aware PAPER MARKET signals the model stop is anchored to
    // the closed-bar reference price. A fresh executable quote can move toward
    // that absolute stop before dispatch; sizing from the shrunken distance
    // would over-size the trade. Preserve the model's intended stop distance
    // here; RiskService re-anchors the same geometry to its own fresh quote.
    const slDistance = riskReferenceEntry.sub(stopLoss).abs();
    if (!slDistance.isPositive()) {
      throw new PositionSizingError(
        'STOP_LOSS_DISTANCE_INVALID',
        `stop-loss distance is zero (risk reference ${riskReferenceEntry.toString()} == stop ${stopLoss.toString()})`,
      );
    }

    // ── 5. Instrument constraints from the §1a seam. ──────────────────────
    const spec = geometry.instrumentSpec;
    if (!spec) {
      throw new PositionSizingError(
        'INSTRUMENT_SPEC_UNPROVABLE',
        `instrument specification for ${instrument} cannot be proven through the seam`,
      );
    }
    const minLot = ExactDecimal.tryParse(spec.minLot);
    const maxLot = ExactDecimal.tryParse(spec.maxLot);
    const lotStep = ExactDecimal.tryParse(spec.lotStep);
    if (
      !minLot ||
      !maxLot ||
      !lotStep ||
      !minLot.isPositive() ||
      !maxLot.isPositive() ||
      !lotStep.isPositive()
    ) {
      throw new PositionSizingError(
        'INSTRUMENT_SPEC_UNPROVABLE',
        `instrument ${instrument} volume constraints are not provable decimals ` +
          `(minLot=${spec.minLot} maxLot=${spec.maxLot} lotStep=${spec.lotStep})`,
      );
    }

    // ── 6. Currency honesty: risk-per-lot is in the QUOTE currency. ──────
    // Standard FX symbols are exactly <BASE><QUOTE>. When the account
    // currency is the quote currency, no conversion is needed. When the
    // account currency is the base currency (e.g. USD account trading
    // USDJPY), the already-proven entry quote is the authoritative
    // quote-currency-per-account-currency conversion rate. For a third-currency
    // account, use only a fresh direct account/quote cross from this exact
    // broker and use its bid conservatively; otherwise fail closed.
    const normalizedInstrument = instrument.toUpperCase();
    if (!/^[A-Z]{6}$/.test(normalizedInstrument)) {
      throw new PositionSizingError(
        'CURRENCY_MISMATCH',
        `cannot prove base/quote currencies of non-standard symbol ${instrument} — ` +
          'cross-currency sizing requires a trusted FX authority',
      );
    }
    const baseCurrency = normalizedInstrument.slice(0, 3);
    const quoteCurrency = normalizedInstrument.slice(3, 6);
    const baseRiskAmount = riskCapitalBase.mul(baseRiskPercent).divByPowerOfTen(2);
    const riskAmount = riskCapitalBase.mul(drawdownAdjustedRiskPercent).divByPowerOfTen(2); // account currency
    let riskAmountInQuoteCurrency: ExactDecimal;
    let riskCurrencyConversion:
      | 'ACCOUNT_IS_QUOTE'
      | 'ACCOUNT_IS_BASE_USING_ENTRY'
      | 'ACCOUNT_TO_QUOTE_USING_BROKER_BID'
      | 'ACCOUNT_TO_QUOTE_USING_BROKER_NATIVE_EVIDENCE';
    let quotePerAccountCurrency = ExactDecimal.ONE;
    let riskCurrencyConversionInstrument: string | null = null;
    let riskCurrencyConversionRate: string | null = null;
    if (quoteCurrency === accountCurrency) {
      riskAmountInQuoteCurrency = riskAmount;
      riskCurrencyConversion = 'ACCOUNT_IS_QUOTE';
    } else if (baseCurrency === accountCurrency) {
      quotePerAccountCurrency = entry;
      riskAmountInQuoteCurrency = riskAmount.mul(quotePerAccountCurrency);
      riskCurrencyConversion = 'ACCOUNT_IS_BASE_USING_ENTRY';
      riskCurrencyConversionInstrument = normalizedInstrument;
      riskCurrencyConversionRate = quotePerAccountCurrency.toString();
    } else {
      const conversionInstrument = `${accountCurrency}${quoteCurrency}`;
      const cachedConversion = this.brokerFxConversion
        ? await this.brokerFxConversion.resolveCachedBid(
            brokerConnectionId,
            accountCurrency,
            quoteCurrency,
            new Date(),
          )
        : null;
      const cachedBid = ExactDecimal.tryParse(cachedConversion?.rate ?? '');
      if (cachedConversion && cachedBid?.isPositive()) {
        quotePerAccountCurrency = cachedBid;
        riskAmountInQuoteCurrency = riskAmount.mul(quotePerAccountCurrency);
        riskCurrencyConversion = 'ACCOUNT_TO_QUOTE_USING_BROKER_NATIVE_EVIDENCE';
        riskCurrencyConversionInstrument = cachedConversion.path.join('>');
        riskCurrencyConversionRate = quotePerAccountCurrency.toString();
      } else {
        let conversionQuote: Awaited<ReturnType<BrokerService['getCurrentPriceForConnection']>> =
          null;
        try {
          conversionQuote = await this.brokerService.getCurrentPriceForConnection(
            userId,
            brokerConnectionId,
            conversionInstrument,
            { propagateProviderError: true },
          );
        } catch {
          conversionQuote = null;
        }
        const conversionBid = ExactDecimal.tryParse(conversionQuote?.bid ?? '');
        const conversionTimestamp = conversionQuote?.timestamp
          ? new Date(conversionQuote.timestamp).getTime()
          : Number.NaN;
        const conversionAgeMs = Date.now() - conversionTimestamp;
        if (
          !conversionBid ||
          !conversionBid.isPositive() ||
          !Number.isFinite(conversionTimestamp) ||
          conversionAgeMs < -5_000 ||
          conversionAgeMs > 60_000
        ) {
          throw new PositionSizingError(
            'CURRENCY_MISMATCH',
            `instrument ${instrument} is ${baseCurrency}/${quoteCurrency} but account currency is ` +
              `${accountCurrency} — fresh broker conversion ${conversionInstrument} could not be proven`,
          );
        }
        quotePerAccountCurrency = conversionBid;
        riskAmountInQuoteCurrency = riskAmount.mul(quotePerAccountCurrency);
        riskCurrencyConversion = 'ACCOUNT_TO_QUOTE_USING_BROKER_BID';
        riskCurrencyConversionInstrument = conversionInstrument;
        riskCurrencyConversionRate = quotePerAccountCurrency.toString();
      }
    }

    // Durable PAPER floor authority uses the profile's maximum trade risk as
    // the absolute ceiling. Soft confidence/research/drawdown budgets may size
    // below the product floor, but the floor may be restored only when its
    // actual stop risk is still inside this durable ceiling.
    const profileRiskCeilingAmount = riskCapitalBase.mul(riskPercent).divByPowerOfTen(2);
    const profileRiskCeilingAmountInQuoteCurrency =
      profileRiskCeilingAmount.mul(quotePerAccountCurrency);

    // ── 7. The sizing math (ExactDecimal only). ───────────────────────────
    const riskPerLot = slDistance.mul(contractSize);
    const lotsByRiskBudget = riskAmountInQuoteCurrency.divDown(riskPerLot, LOT_SCALE);
    if (!lotsByRiskBudget.isPositive()) {
      throw new PositionSizingError(
        'POSITION_SIZE_ZERO',
        `risk budget ${riskAmount.toString()} cannot afford any volume of ${instrument} ` +
          `(risk per lot ${riskPerLot.toString()})`,
      );
    }
    const requestedLotUpperBound = ExactDecimal.tryParse(params.requestedLotUpperBound);
    if (!requestedLotUpperBound || !requestedLotUpperBound.isPositive()) {
      throw new PositionSizingError(
        'RISK_BUDGET_UNPARSEABLE',
        `AI requested lot upper bound is not a provable positive decimal: ${params.requestedLotUpperBound}`,
      );
    }

    // Pre-size against the SAME effective-leverage ceiling enforced by the
    // final RiskService. This prevents a qualified setup from being discarded
    // simply because its initial requested volume is slightly too large.
    //
    // entry * contractSize is quote-currency notional per lot. Dividing by the
    // already-proven quote-per-account-currency rate yields account-currency
    // notional per lot for all three supported FX cases:
    //   account==quote -> divide by 1
    //   account==base  -> divide by entry
    //   third currency -> divide by fresh ACCOUNT/QUOTE broker BID
    const notionalPerLotAccountCurrency = entry
      .mul(contractSize)
      .divUp(quotePerAccountCurrency, 12);
    if (!notionalPerLotAccountCurrency.isPositive()) {
      throw new PositionSizingError(
        'RISK_BUDGET_UNPARSEABLE',
        `account-currency notional per lot is not positive for ${instrument}`,
      );
    }
    const maxNotionalAtLeverageLimit = equity.mul(maxLeverageAllowed);
    const rawLotsByLeverageCeiling = maxNotionalAtLeverageLimit.divDown(
      notionalPerLotAccountCurrency,
      LOT_SCALE,
    );
    const leverageSteps = rawLotsByLeverageCeiling.divDown(lotStep, 0);
    let lotsByLeverageCeiling = leverageSteps.mul(lotStep);

    // RiskService rejects leverage >= maxLeverageAllowed. If the normalized
    // volume lands exactly on that boundary, step down once so the sizing
    // result is strictly below the durable limit rather than guaranteed to be
    // rejected downstream.
    if (lotsByLeverageCeiling.isPositive()) {
      const boundaryLeverage = lotsByLeverageCeiling
        .mul(notionalPerLotAccountCurrency)
        .divUp(equity, LOT_SCALE);
      if (boundaryLeverage.gte(maxLeverageAllowed)) {
        lotsByLeverageCeiling = lotsByLeverageCeiling.sub(lotStep);
      }
    }
    if (!lotsByLeverageCeiling.isPositive()) {
      const belowBrokerMin =
        rawLotsByLeverageCeiling.isPositive() && rawLotsByLeverageCeiling.lt(minLot);
      throw new PositionSizingError(
        belowBrokerMin ? 'POSITION_SIZE_BELOW_MINIMUM' : 'POSITION_SIZE_ZERO',
        `max leverage ${maxLeverageAllowed.toString()}x supports at most ` +
          `${rawLotsByLeverageCeiling.toString()} lots of ${instrument} ` +
          `at equity ${equity.toString()}, below the broker minimum/step ` +
          `${minLot.toString()}/${lotStep.toString()}; no trade is affordable`,
      );
    }

    // Promoted non-LIVE execution has one professional product floor. Research
    // and scout callers may request a smaller cap for evidence collection, but
    // that micro-volume is no longer executable: the hard floor below causes
    // those requests to abstain instead of dispatching 0.05/0.10 lots.
    const paperProductMinimumLot = allocationAwarePaper ? minLot : null;
    const paperPreferredLot = allocationAwarePaper
      ? ExactDecimal.parse(PAPER_PRODUCT_PREFERRED_LOT)
      : null;
    const paperProductMaximumLot = allocationAwarePaper
      ? ExactDecimal.parse(PAPER_PRODUCT_MAX_LOT)
      : null;
    let effectiveRequestedLotUpperBound = requestedLotUpperBound;
    if (paperProductMinimumLot && paperProductMaximumLot) {
      // PAPER may cap an oversized caller request at the product maximum.
      // Never raise the explicit model/research upper bound to a preferred
      // lot size; the broker minimum is the sole hard executable floor.
      effectiveRequestedLotUpperBound = ExactDecimal.min(
        requestedLotUpperBound,
        paperProductMaximumLot,
      );
    }

    let lotsBeforeStep = ExactDecimal.min(
      ExactDecimal.min(lotsByRiskBudget, maxLot),
      lotsByLeverageCeiling,
    );
    if (paperProductMaximumLot) {
      lotsBeforeStep = ExactDecimal.min(lotsBeforeStep, paperProductMaximumLot);
    }
    if (!removeProfileLotCeiling) {
      lotsBeforeStep = ExactDecimal.min(lotsBeforeStep, profileMaxLots);
    }
    if (!removeAiLotCeiling) {
      lotsBeforeStep = ExactDecimal.min(lotsBeforeStep, effectiveRequestedLotUpperBound);
    }

    // Normalize DOWN to the instrument's volume step (conservative for risk).
    const steps = lotsBeforeStep.divDown(lotStep, 0); // integer step count
    let lots = steps.mul(lotStep);

    if (!lots.isPositive()) {
      if (lotsBeforeStep.isPositive() && lotsBeforeStep.lt(minLot)) {
        throw new PositionSizingError(
          'POSITION_SIZE_BELOW_MINIMUM',
          `account risk/leverage can support only ${lotsBeforeStep.toString()} lots ` +
            `of ${instrument}, below the broker instrument minimum ${minLot.toString()}; ` +
            'choose a broker/symbol with a lower minimum or a smaller contract, not higher risk',
        );
      }
      throw new PositionSizingError(
        'POSITION_SIZE_ZERO',
        `step normalization collapsed the volume to zero (raw ${lotsBeforeStep.toString()}, step ${lotStep.toString()})`,
      );
    }
    if (lots.lt(minLot)) {
      throw new PositionSizingError(
        'POSITION_SIZE_BELOW_MINIMUM',
        `risk-budget volume ${lots.toFixed(LOT_SCALE, 'DOWN')} is below the instrument ` +
          `minimum ${minLot.toString()} — rounding UP would exceed the risk budget`,
      );
    }

    let policyMinimumExecutableLot: ExactDecimal | null = null;
    let policyMinimumLotLifted = false;
    if (allocationAwarePaper && paperPreferredLot) {
      let requestedPolicyMinimumLot = ExactDecimal.parse(PAPER_PRODUCT_DEFAULT_MIN_LOT);
      if (params.paperAllocationSizing?.minimumExecutableLot != null) {
        const parsedRequestedMinimum = ExactDecimal.tryParse(
          params.paperAllocationSizing.minimumExecutableLot,
        );
        if (!parsedRequestedMinimum || !parsedRequestedMinimum.isPositive()) {
          throw new PositionSizingError(
            'POLICY_MINIMUM_LOT_UNPROVABLE',
            `PAPER minimum executable lot is not a provable positive decimal: ${params.paperAllocationSizing.minimumExecutableLot}`,
          );
        }
        requestedPolicyMinimumLot = parsedRequestedMinimum;
      }
      policyMinimumExecutableLot = ExactDecimal.max(requestedPolicyMinimumLot, paperPreferredLot);

      // 0.20 lot is a PREFERRED size, not an executable minimum. The
      // actual minimum is ALWAYS the instrument's proven minLot/lotStep.
      // Never promote a proposed volume above the model's cap, broker max,
      // leverage ceiling, or the durable full-risk stop ceiling.
      const floorSteps = policyMinimumExecutableLot.divDown(lotStep, 0);
      const normalizedFloor = floorSteps.mul(lotStep);
      const floorFitsBrokerAndModelCeilings =
        normalizedFloor.eq(policyMinimumExecutableLot) &&
        policyMinimumExecutableLot.lte(maxLot) &&
        (removeAiLotCeiling || policyMinimumExecutableLot.lte(effectiveRequestedLotUpperBound));
      const floorFitsAccountLotCeilings =
        policyMinimumExecutableLot.lte(lotsByLeverageCeiling) &&
        (removeProfileLotCeiling || policyMinimumExecutableLot.lte(profileMaxLots));

      if (lots.lt(policyMinimumExecutableLot)) {
        const floorRiskInQuoteCurrency = policyMinimumExecutableLot.mul(riskPerLot);
        const floorFitsDurableRisk = floorRiskInQuoteCurrency.lte(
          profileRiskCeilingAmountInQuoteCurrency,
        );
        // Preserve the original risk-safe preference promotion on a funded
        // account, but an unaffordable floor must NEVER veto a smaller
        // otherwise-authorized broker volume. Micro-volumes still require
        // every execution/risk/commission gate downstream.
        if (
          floorFitsBrokerAndModelCeilings &&
          floorFitsAccountLotCeilings &&
          floorFitsDurableRisk &&
          policyMinimumExecutableLot.gte(minLot)
        ) {
          lots = policyMinimumExecutableLot;
          policyMinimumLotLifted = true;
        }
      }
    }

    // ── 8. Broker-margin affordability: preserve the signal, reduce only size. ──
    // Risk geometry may admit a professional lot size whose broker-native initial
    // margin no longer fits the account after equity/free-margin changes. Do not
    // throw the whole qualified setup away: step down conservatively to the
    // largest broker lot increment whose EXPECTED_MARGIN fits both current free
    // margin and the AI risk-capital base. RiskService independently re-checks
    // current broker free margin immediately before execution (defense in depth).
    // Under $50 equivalent equity, retain at least 20% of both allocation
    // and free margin as a buffer. Fees, spreads, and adverse movement can
    // exhaust a $5 account especially quickly. This buffer is separate from
    // the hard per-trade risk and effective leverage limits.
    const microAccountMarginReservePercent =
      allocationAwarePaper && equity.lte(MICRO_EQUITY_THRESHOLD) ? '20' : null;
    const marginCapacity = ExactDecimal.min(freeMargin, riskCapitalBase).mul(
      microAccountMarginReservePercent ? MICRO_MARGIN_CAPACITY_MULTIPLIER : ExactDecimal.ONE,
    );
    // Broker minimum is the only hard volume floor. No 0.10/0.20 product floor
    // may prevent a duly risk-sized micro trade.
    const minimumMarginAffordableLot = minLot;

    const requiredMarginForLots = async (candidateLots: ExactDecimal): Promise<ExactDecimal> => {
      let raw: string | null = null;
      try {
        raw = await this.brokerService.getRequiredMargin(brokerConnectionId, {
          instrument,
          lotSize: candidateLots.toString(),
          direction: params.direction,
        });
      } catch {
        raw = null;
      }
      const parsed = ExactDecimal.tryParse(raw ?? '');
      if (!parsed || !parsed.isPositive()) {
        throw new PositionSizingError(
          'REQUIRED_MARGIN_UNPROVABLE',
          `broker could not prove required margin for ${candidateLots.toString()} lots of ${instrument}`,
        );
      }
      return parsed;
    };

    let requiredMargin = await requiredMarginForLots(lots);
    if (requiredMargin.gt(marginCapacity)) {
      const minimumStepsDecimal = minimumMarginAffordableLot.divDown(lotStep, 0);
      const maximumStepsDecimal = lots.divDown(lotStep, 0);
      let low = BigInt(minimumStepsDecimal.toString());
      let high = BigInt(maximumStepsDecimal.toString());
      let bestLots: ExactDecimal | null = null;
      let bestMargin: ExactDecimal | null = null;

      while (low <= high) {
        const middle = (low + high) / 2n;
        const candidateLots = lotStep.mul(ExactDecimal.parse(middle.toString()));
        if (candidateLots.lt(minimumMarginAffordableLot)) {
          low = middle + 1n;
          continue;
        }
        const candidateMargin = await requiredMarginForLots(candidateLots);
        if (candidateMargin.lte(marginCapacity)) {
          bestLots = candidateLots;
          bestMargin = candidateMargin;
          low = middle + 1n;
        } else {
          high = middle - 1n;
        }
      }

      if (!bestLots || !bestMargin) {
        throw new PositionSizingError(
          'BROKER_MINIMUM_MARGIN_UNAFFORDABLE',
          `broker margin capacity ${marginCapacity.toString()} ${accountCurrency} after ` +
            `micro-account reserve cannot afford the instrument minimum ` +
            `${minimumMarginAffordableLot.toString()} lots of ${instrument}; ` +
            'smaller trades require a broker-supported lower volume/contract size',
        );
      }

      this.logger.log(
        `Margin-cap step-down ${instrument} ${params.direction}: ${lots.toString()} -> ` +
          `${bestLots.toString()} lots (requiredMargin ${requiredMargin.toString()} -> ` +
          `${bestMargin.toString()} ${accountCurrency}, capacity ${marginCapacity.toString()})`,
      );
      lots = bestLots;
      requiredMargin = bestMargin;
    }

    // A model's pre-fill gross R was previously displayed as if it captured
    // the broker's whole stop-out cost. On Pepperstone focused DEMO M1 the
    // actual fill can be adverse to the last quote, and an SL close has fees.
    // Keep the original intended gross stop-risk amount as a *monetary*
    // envelope, not a hard volume floor. Use broker-observed spread and
    // strictly PRIOR paid commissions to step size DOWN. The market order,
    // broker SL/TP, independent risk engine, and signal gates stay unchanged.
    // No invented fee: unavailable history is labelled and only the observed
    // spread component is covered. The projection is NOT a slippage guarantee.
    let demoExecutionRiskEnvelope: PositionSizingInputs['demoExecutionRiskEnvelope'];
    const pepperstoneFocusedDemo =
      allocationAwarePaper &&
      params.paperAllocationSizing?.executionMode === 'FULL_AUTO' &&
      paperBrokerAccountType === 'DEMO' &&
      paperBrokerId === 'pepperstone-ctrader' &&
      (normalizedInstrument === 'EURUSD' || normalizedInstrument === 'AUDUSD') &&
      accountCurrency === quoteCurrency &&
      params.entryType === 'MARKET';
    if (pepperstoneFocusedDemo) {
      const quoteRef = geometry.quoteRef;
      const bid = ExactDecimal.tryParse(String(quoteRef?.bid ?? ''));
      const ask = ExactDecimal.tryParse(String(quoteRef?.ask ?? ''));
      const quoteAt = Date.parse(String(quoteRef?.observedAt ?? ''));
      const quoteAgeMs = Date.now() - quoteAt;
      if (
        bid?.isPositive() && ask?.isPositive() && ask.gte(bid) &&
        Number.isFinite(quoteAgeMs) && quoteAgeMs >= -5_000 && quoteAgeMs <= 60_000
      ) {
        const originalLots = lots;
        const observedSpread = ask.sub(bid);
        const reserveMultiple = ExactDecimal.parse('2');
        const spreadReservePerLot = observedSpread.mul(reserveMultiple).mul(contractSize);
        const feeEvidence = await this.loadPepperstoneDemoHistoricalFeePerLot({
          userId, brokerConnectionId, accountCurrency, instrument: normalizedInstrument,
          asOf: new Date(),
        });
        const historicalFeePerLot = feeEvidence
          ? ExactDecimal.parse(feeEvidence.feePerLot)
          : ExactDecimal.ZERO;
        const reservePerLot = spreadReservePerLot.add(historicalFeePerLot);
        if (reservePerLot.isPositive()) {
          const nominalStopRiskCeiling = originalLots.mul(riskPerLot);
          const projectedRiskPerLot = riskPerLot.add(reservePerLot);
          const lotsWithinEnvelope = nominalStopRiskCeiling
            .divDown(projectedRiskPerLot, LOT_SCALE)
            .divDown(lotStep, 0).mul(lotStep);
          if (lotsWithinEnvelope.lt(minLot)) {
            throw new PositionSizingError(
              'POSITION_SIZE_BELOW_MINIMUM',
              `${instrument}: broker spread/fee-aware size ${lotsWithinEnvelope.toString()} ` +
              `is below verified minimum ${minLot.toString()}; never round risk up`,
            );
          }
          if (lotsWithinEnvelope.lt(lots)) {
            lots = lotsWithinEnvelope;
            requiredMargin = await requiredMarginForLots(lots);
          }
        }
        demoExecutionRiskEnvelope = {
          artifact: 'pepperstone-demo-cost-aware-risk-sizing-v1',
          originalLots: originalLots.toString(),
          initialGrossStopRisk: originalLots.mul(riskPerLot).toString(),
          adjustedLots: lots.toString(),
          modelStopDistance: slDistance.toString(),
          observedSpread: observedSpread.toString(),
          spreadReserveMultiple: 2,
          historicalFeePerLot: feeEvidence?.feePerLot ?? null,
          historicalFeeSamples: feeEvidence?.sampleCount ?? 0,
          feeSource: feeEvidence?.source ?? 'UNAVAILABLE',
          conservativeEstimatedStopRisk: lots.mul(
            riskPerLot.add(spreadReservePerLot).add(historicalFeePerLot),
          ).toString(),
          commissionIncluded: feeEvidence !== null,
          isGuaranteedMaximumLoss: false,
        };
      }
    }

    const finalRiskAtStopInQuoteCurrency = lots.mul(riskPerLot);
    const finalRiskAtStop = finalRiskAtStopInQuoteCurrency.divDown(
      quotePerAccountCurrency,
      LOT_SCALE,
    );
    const finalRiskAtStopPercentOfCapital = finalRiskAtStop
      .divDown(riskCapitalBase, LOT_SCALE)
      .mulByPowerOfTen(2);

    const finalNotionalAccountCurrency = lots.mul(notionalPerLotAccountCurrency);
    const finalEffectiveLeverage = finalNotionalAccountCurrency.divUp(equity, LOT_SCALE);
    if (finalEffectiveLeverage.gte(maxLeverageAllowed)) {
      throw new PositionSizingError(
        'POSITION_SIZE_ZERO',
        `sized leverage ${finalEffectiveLeverage.toString()}x is not strictly below ` +
          `${maxLeverageAllowed.toString()}x for ${instrument}`,
      );
    }

    // Capital commitment remains broker-required margin; the affordability
    // step above has already reduced the final lot to a margin-feasible size.
    const grossNotional = lots.mul(contractSize).mul(entry);
    const allocatedCapital = requiredMargin;

    const inputs: PositionSizingInputs = {
      accountCurrency,
      equity: equity.toString(),
      freeMargin: freeMargin.toString(),
      riskPercent: drawdownAdjustedRiskPercent.toString(),
      requestedRiskPercent: requestedRiskPercent.toString(),
      baseRiskPercent: baseRiskPercent.toString(),
      adaptiveRiskMultiplier: adaptiveRiskMultiplier.toString(),
      adaptiveRiskPercent: adaptiveRiskPercent.toString(),
      sessionPeakEquity: params.paperAllocationSizing?.sessionPeakEquity ?? null,
      currentDrawdownPercent: drawdownAdjustment.currentDrawdownPercent,
      maxDrawdownPercent: drawdownAdjustment.maxDrawdownPercent,
      drawdownRiskMultiplier: drawdownRiskMultiplier.toString(),
      combinedRiskMultiplier: combinedRiskMultiplier.toString(),
      drawdownAdjustedRiskPercent: drawdownAdjustedRiskPercent.toString(),
      riskCapitalBase: riskCapitalBase.toString(),
      allocationAwarePaper,
      riskReferenceEntryPrice: riskReferenceEntry.toString(),
      baseRiskAmount: baseRiskAmount.toString(),
      riskAmount: riskAmount.toString(),
      baseCurrency,
      quoteCurrency,
      riskAmountInQuoteCurrency: riskAmountInQuoteCurrency.toString(),
      riskCurrencyConversion,
      riskCurrencyConversionInstrument,
      riskCurrencyConversionRate,
      entryPrice: entry.toString(),
      entryPriceSource,
      stopLoss: stopLoss.toString(),
      stopLossDistance: slDistance.toString(),
      contractSize: contractSize.toString(),
      minLot: minLot.toString(),
      policyMinimumExecutableLot: policyMinimumExecutableLot?.toString() ?? null,
      policyMinimumLotLifted,
      preferredLotTarget: policyMinimumExecutableLot?.toString() ?? null,
      lotSelectionReason:
        allocationAwarePaper && policyMinimumExecutableLot
          ? lots.gte(policyMinimumExecutableLot)
            ? 'PREFERRED_LOT_ACHIEVED'
            : 'BROKER_RISK_SCALED_DOWN'
          : 'STANDARD_RISK_SIZING',
      microAccountMarginReservePercent,
      finalRiskAtStop: finalRiskAtStop.toString(),
      finalRiskAtStopPercentOfCapital: finalRiskAtStopPercentOfCapital.toString(),
      ...(demoExecutionRiskEnvelope ? { demoExecutionRiskEnvelope } : {}),
      maxLot: maxLot.toString(),
      lotStep: lotStep.toString(),
      profileMaxPositionSizeLot: profileMaxLots.toString(),
      maxLeverageAllowed: maxLeverageAllowed.toString(),
      lotsByLeverageCeiling: lotsByLeverageCeiling.toString(),
      notionalPerLotAccountCurrency: notionalPerLotAccountCurrency.toString(),
      finalNotionalAccountCurrency: finalNotionalAccountCurrency.toString(),
      finalEffectiveLeverage: finalEffectiveLeverage.toString(),
      requestedLotUpperBound: requestedLotUpperBound.toString(),
      effectiveRequestedLotUpperBound: effectiveRequestedLotUpperBound.toString(),
      paperProductMinimumLot: paperProductMinimumLot?.toString() ?? null,
      paperProductMaximumLot: paperProductMaximumLot?.toString() ?? null,
      lotsByRiskBudget: lotsByRiskBudget.toString(),
      lotsBeforeStepNormalization: lotsBeforeStep.toString(),
      grossNotional: grossNotional.toString(),
      requiredMargin: requiredMargin.toString(),
      computedAt: new Date().toISOString(),
    };

    this.logger.log(
      `Sized ${instrument} ${params.direction}: ${lots.toString()} lots ` +
        `(actualRiskAtStop ${finalRiskAtStop.toString()} ${accountCurrency} (${finalRiskAtStopPercentOfCapital.toString()}%), ` +
        `softBudget ${riskAmount.toString()} ${accountCurrency} from ${riskCapitalBase.toString()} capital, ` +
        `adaptiveMultiplier ${adaptiveRiskMultiplier.toString()}x, ` +
        `drawdownMultiplier ${drawdownRiskMultiplier.toString()}x, ` +
        `requiredMargin ${allocatedCapital.toString()}, ` +
        `notional ${grossNotional.toString()})`,
    );

    return {
      lots: lots.toString(),
      allocatedCapital: allocatedCapital.toString(),
      accountCurrency,
      entryPrice: entry.toString(),
      inputs,
    };
  }
}
