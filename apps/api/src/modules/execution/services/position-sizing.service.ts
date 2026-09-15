import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { RiskProfile } from '../../risk/entities/risk-profile.entity';
import { BrokerService } from '../../broker/broker.service';
import { RiskOrderGeometryService } from '../../risk/risk-order-geometry.service';

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
  /** The instrument's quote currency is not the account currency — no
   * implicit FX conversion is ever invented (trusted-FX authority required
   * for cross-currency sizing, deliberately out of scope). */
  | 'CURRENCY_MISMATCH'
  /** The risk budget cannot afford the instrument's minimum volume —
   * rounding UP to minLot would EXCEED the risk budget, so it is a
   * rejection, never a round-up. */
  | 'POSITION_SIZE_BELOW_MINIMUM'
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
  riskAmount: string;
  entryPrice: string;
  entryPriceSource: 'MARKET_QUOTE' | 'REQUESTED_LIMIT';
  stopLoss: string;
  stopLossDistance: string;
  contractSize: string;
  minLot: string;
  maxLot: string;
  lotStep: string;
  profileMaxPositionSizeLot: string;
  lotsByRiskBudget: string;
  lotsBeforeStepNormalization: string;
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
/** Decimal scale for capital (notional) math. */
const CAPITAL_SCALE = 8;

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
 *  - Margin enforcement stays at the existing risk gate (adapter-backed
 *    INSUFFICIENT_MARGIN check) — sizing does not duplicate network calls;
 *    the gate re-validates the sized order against CURRENT facts (§5).
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

    // ── 3. Geometry: entry reference + PROVEN contract size (§1a seam). ───
    const geometry = await this.orderGeometry.resolveOrderGeometry({
      userId,
      brokerConnectionId,
      instrument,
      needFreshQuote: params.entryType === 'MARKET',
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
    const slDistance = entry.sub(stopLoss).abs();
    if (!slDistance.isPositive()) {
      throw new PositionSizingError(
        'STOP_LOSS_DISTANCE_INVALID',
        `stop-loss distance is zero (entry ${entry.toString()} == stop ${stopLoss.toString()})`,
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
    if (!minLot || !maxLot || !lotStep || !minLot.isPositive() || !maxLot.isPositive() || !lotStep.isPositive()) {
      throw new PositionSizingError(
        'INSTRUMENT_SPEC_UNPROVABLE',
        `instrument ${instrument} volume constraints are not provable decimals ` +
          `(minLot=${spec.minLot} maxLot=${spec.maxLot} lotStep=${spec.lotStep})`,
      );
    }

    // ── 6. Currency honesty: notional is in the QUOTE currency. ───────────
    // Standard FX symbols are <BASE><QUOTE> (6 alpha chars). The quote
    // currency must equal the account currency — otherwise an implicit FX
    // conversion would be invented, which is forbidden.
    if (!/^[A-Z]{6,}$/.test(instrument.toUpperCase())) {
      throw new PositionSizingError(
        'CURRENCY_MISMATCH',
        `cannot prove the quote currency of non-standard symbol ${instrument} — ` +
          'cross-currency sizing requires a trusted FX authority (out of scope)',
      );
    }
    const quoteCurrency = instrument.toUpperCase().slice(3, 6);
    if (quoteCurrency !== accountCurrency) {
      throw new PositionSizingError(
        'CURRENCY_MISMATCH',
        `instrument ${instrument} quotes in ${quoteCurrency} but the account is ` +
          `${accountCurrency} — no implicit FX conversion is invented`,
      );
    }

    // ── 7. The sizing math (ExactDecimal only). ───────────────────────────
    const riskAmount = equity.mul(riskPercent).divByPowerOfTen(2); // pct → fraction
    const riskPerLot = slDistance.mul(contractSize);
    const lotsByRiskBudget = riskAmount.divDown(riskPerLot, LOT_SCALE);
    if (!lotsByRiskBudget.isPositive()) {
      throw new PositionSizingError(
        'POSITION_SIZE_ZERO',
        `risk budget ${riskAmount.toString()} cannot afford any volume of ${instrument} ` +
          `(risk per lot ${riskPerLot.toString()})`,
      );
    }
    const lotsBeforeStep = ExactDecimal.min(
      ExactDecimal.min(lotsByRiskBudget, profileMaxLots),
      maxLot,
    );

    // Normalize DOWN to the instrument's volume step (conservative for risk).
    const steps = lotsBeforeStep.divDown(lotStep, 0); // integer step count
    const lots = steps.mul(lotStep);

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

    const allocatedCapital = lots.mul(contractSize).mul(entry);

    const inputs: PositionSizingInputs = {
      accountCurrency,
      equity: equity.toString(),
      freeMargin: freeMargin.toString(),
      riskPercent: riskPercent.toString(),
      riskAmount: riskAmount.toString(),
      entryPrice: entry.toString(),
      entryPriceSource,
      stopLoss: stopLoss.toString(),
      stopLossDistance: slDistance.toString(),
      contractSize: contractSize.toString(),
      minLot: minLot.toString(),
      maxLot: maxLot.toString(),
      lotStep: lotStep.toString(),
      profileMaxPositionSizeLot: profileMaxLots.toString(),
      lotsByRiskBudget: lotsByRiskBudget.toString(),
      lotsBeforeStepNormalization: lotsBeforeStep.toString(),
      computedAt: new Date().toISOString(),
    };

    this.logger.log(
      `Sized ${instrument} ${params.direction}: ${lots.toString()} lots ` +
        `(risk ${riskAmount.toString()} ${accountCurrency}, capital ${allocatedCapital.toString()})`,
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
