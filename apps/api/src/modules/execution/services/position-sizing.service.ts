import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { RiskProfile } from '../../risk/entities/risk-profile.entity';
import { BrokerService } from '../../broker/broker.service';
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
  /** The instrument's quote currency is not the account currency — no
   * implicit FX conversion is ever invented (trusted-FX authority required
   * for cross-currency sizing, deliberately out of scope). */
  | 'CURRENCY_MISMATCH'
  /** The risk budget cannot afford the instrument's minimum volume —
   * rounding UP to minLot would EXCEED the risk budget, so it is a
   * rejection, never a round-up. */
  | 'POSITION_SIZE_BELOW_MINIMUM'
  | 'POSITION_SIZE_BELOW_POLICY_MINIMUM'
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
  riskCurrencyConversion: 'ACCOUNT_IS_QUOTE' | 'ACCOUNT_IS_BASE_USING_ENTRY';
  entryPrice: string;
  entryPriceSource: 'MARKET_QUOTE' | 'REQUESTED_LIMIT';
  stopLoss: string;
  stopLossDistance: string;
  contractSize: string;
  minLot: string;
  policyMinimumExecutableLot?: string | null;
  policyMinimumLotLifted?: boolean;
  finalRiskAtStop?: string;
  finalRiskAtStopPercentOfCapital?: string;
  maxLot: string;
  lotStep: string;
  profileMaxPositionSizeLot: string;
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
export const PAPER_PRODUCT_ABSOLUTE_MIN_LOT = '0.1';
const PAPER_PRODUCT_DEFAULT_MIN_LOT = '0.2';
const PAPER_PRODUCT_MAX_LOT = '2';

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
 *  - Currency honesty: the notional is computed in the instrument's QUOTE
 *    currency; when that is not the account currency the sizing fails with
 *    CURRENCY_MISMATCH — no implicit FX conversion is ever invented.
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
  ) {}

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
      /** PAPER-only product floor. May lift soft-budget sizing up to this floor when the final stop risk remains inside the durable profile ceiling. */
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

    let effectiveRiskPercent = riskPercent;
    let requestedRiskPercent = riskPercent;
    let riskCapitalBase = equity;
    let allocationAwarePaper = false;
    let removeAiLotCeiling = false;
    let removeProfileLotCeiling = false;

    if (params.paperAllocationSizing) {
      const allocatedCapital = ExactDecimal.tryParse(
        params.paperAllocationSizing.allocatedCapital ?? '',
      );
      const policy = paperAllocationSizingPolicy({
        executionMode: params.paperAllocationSizing.executionMode,
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
    // quote-currency-per-account-currency conversion rate. A third-currency
    // account still fails closed because that would require another trusted
    // FX conversion authority.
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
    let riskCurrencyConversion: 'ACCOUNT_IS_QUOTE' | 'ACCOUNT_IS_BASE_USING_ENTRY';
    if (quoteCurrency === accountCurrency) {
      riskAmountInQuoteCurrency = riskAmount;
      riskCurrencyConversion = 'ACCOUNT_IS_QUOTE';
    } else if (baseCurrency === accountCurrency) {
      riskAmountInQuoteCurrency = riskAmount.mul(entry);
      riskCurrencyConversion = 'ACCOUNT_IS_BASE_USING_ENTRY';
    } else {
      throw new PositionSizingError(
        'CURRENCY_MISMATCH',
        `instrument ${instrument} is ${baseCurrency}/${quoteCurrency} but account currency is ` +
          `${accountCurrency} — neither FX leg matches the account currency`,
      );
    }

    // Durable PAPER floor authority uses the profile's maximum trade risk as
    // the absolute ceiling. Soft confidence/research/drawdown budgets may size
    // below the product floor, but the floor may be restored only when its
    // actual stop risk is still inside this durable ceiling.
    const profileRiskCeilingAmount = riskCapitalBase.mul(riskPercent).divByPowerOfTen(2);
    const profileRiskCeilingAmountInQuoteCurrency =
      riskCurrencyConversion === 'ACCOUNT_IS_QUOTE'
        ? profileRiskCeilingAmount
        : profileRiskCeilingAmount.mul(entry);

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

    const paperProductMinimumLot = allocationAwarePaper
      ? ExactDecimal.parse(PAPER_PRODUCT_ABSOLUTE_MIN_LOT)
      : null;
    const paperProductMaximumLot = allocationAwarePaper
      ? ExactDecimal.parse(PAPER_PRODUCT_MAX_LOT)
      : null;
    let effectiveRequestedLotUpperBound = requestedLotUpperBound;
    if (paperProductMinimumLot && paperProductMaximumLot) {
      // PAPER sizing has an absolute 0.10–2.00 lot product band. Normal PAPER
      // callers explicitly/default to 0.20; evidence-backed scouts may request
      // the 0.10 floor. Caller hints above 2.00 cannot exceed the product maximum.
      effectiveRequestedLotUpperBound = ExactDecimal.min(
        ExactDecimal.max(requestedLotUpperBound, paperProductMinimumLot),
        paperProductMaximumLot,
      );
    }

    let lotsBeforeStep = ExactDecimal.min(lotsByRiskBudget, maxLot);
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
    if (allocationAwarePaper && paperProductMinimumLot) {
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
      policyMinimumExecutableLot = ExactDecimal.max(
        requestedPolicyMinimumLot,
        paperProductMinimumLot,
      );

      // The product floor must itself be a broker-valid step and stay inside
      // every hard lot ceiling. We never use the floor to bypass broker specs
      // or an explicit model upper bound.
      const floorSteps = policyMinimumExecutableLot.divDown(lotStep, 0);
      const normalizedFloor = floorSteps.mul(lotStep);
      const floorFitsLotCeilings =
        normalizedFloor.eq(policyMinimumExecutableLot) &&
        policyMinimumExecutableLot.lte(maxLot) &&
        (removeProfileLotCeiling || policyMinimumExecutableLot.lte(profileMaxLots)) &&
        (removeAiLotCeiling || policyMinimumExecutableLot.lte(effectiveRequestedLotUpperBound));

      if (lots.lt(policyMinimumExecutableLot)) {
        const floorRiskInQuoteCurrency = policyMinimumExecutableLot.mul(riskPerLot);
        const floorFitsDurableRisk = floorRiskInQuoteCurrency.lte(
          profileRiskCeilingAmountInQuoteCurrency,
        );

        if (!floorFitsLotCeilings || !floorFitsDurableRisk) {
          throw new PositionSizingError(
            'POSITION_SIZE_BELOW_POLICY_MINIMUM',
            `risk-budget volume ${lots.toFixed(LOT_SCALE, 'DOWN')} is below the PAPER policy minimum ` +
              `${policyMinimumExecutableLot.toString()} and lifting to the floor would exceed a durable ` +
              `lot/risk ceiling`,
          );
        }

        lots = policyMinimumExecutableLot;
        policyMinimumLotLifted = true;
      }
    }

    const finalRiskAtStopInQuoteCurrency = lots.mul(riskPerLot);
    const finalRiskAtStop =
      riskCurrencyConversion === 'ACCOUNT_IS_QUOTE'
        ? finalRiskAtStopInQuoteCurrency
        : finalRiskAtStopInQuoteCurrency.divDown(entry, LOT_SCALE);
    const finalRiskAtStopPercentOfCapital = finalRiskAtStop
      .divDown(riskCapitalBase, LOT_SCALE)
      .mulByPowerOfTen(2);

    // ── 8. Capital commitment = broker-required margin, not gross notional. ──
    // A leveraged FX position's notional can be many times larger than the
    // actual account capital consumed. Comparing gross notional with the user's
    // explicit AI allocation makes even minimum-lot trades impossible on a
    // modest allocation (e.g. 0.01 EURUSD ≈ 1,000 EUR notional but only about
    // 1% of that capital at 100:1 leverage). The broker adapter already owns
    // the instrument/provider-specific margin formula, so reuse that authority.
    const grossNotional = lots.mul(contractSize).mul(entry);
    let requiredMarginRaw: string | null = null;
    try {
      requiredMarginRaw = await this.brokerService.getRequiredMargin(brokerConnectionId, {
        instrument,
        lotSize: lots.toString(),
        direction: params.direction,
      });
    } catch {
      requiredMarginRaw = null;
    }
    const requiredMargin = ExactDecimal.tryParse(requiredMarginRaw ?? '');
    if (!requiredMargin || !requiredMargin.isPositive()) {
      throw new PositionSizingError(
        'REQUIRED_MARGIN_UNPROVABLE',
        `broker could not prove required margin for ${lots.toString()} lots of ${instrument}`,
      );
    }

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
      entryPrice: entry.toString(),
      entryPriceSource,
      stopLoss: stopLoss.toString(),
      stopLossDistance: slDistance.toString(),
      contractSize: contractSize.toString(),
      minLot: minLot.toString(),
      policyMinimumExecutableLot: policyMinimumExecutableLot?.toString() ?? null,
      policyMinimumLotLifted,
      finalRiskAtStop: finalRiskAtStop.toString(),
      finalRiskAtStopPercentOfCapital: finalRiskAtStopPercentOfCapital.toString(),
      maxLot: maxLot.toString(),
      lotStep: lotStep.toString(),
      profileMaxPositionSizeLot: profileMaxLots.toString(),
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
