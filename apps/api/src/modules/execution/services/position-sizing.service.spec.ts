import { PositionSizingError, PositionSizingService } from './position-sizing.service';
import { RiskProfile } from '../../risk/entities/risk-profile.entity';
import { BrokerService } from '../../broker/broker.service';
import { RiskOrderGeometryService } from '../../risk/risk-order-geometry.service';
import type { BrokerInstrument } from '../../broker/interfaces/broker-adapter.interface';
import { ExactDecimal } from '../../../common/utils/exact-decimal';

/**
 * PositionSizingService (Round 6 live-execution completion §4) — the
 * deterministic fail-closed sizing matrix.
 *
 * Collaborators are mocked at the SEAM (the authoritative account state, the
 * risk-geometry quote/contract-size proof and the durable profile row); the
 * SIZING MATH itself is the real production code under test and every
 * expected value is verified as an EXACT decimal string — the test never
 * uses JavaScript floating-point to assert sizing outputs.
 *
 * Matrix (§4):
 *   - happy path: lots = risk budget / (SL distance × contract size),
 *     clamped by profile cap + instrument max, normalized DOWN to the
 *     volume step; capital = lots × contract size × entry
 *   - every missing/unprovable input → the TYPED fail-closed code
 *     (equity, free margin, currency, spec, contract size, stop loss,
 *     entry quote, profile) — NEVER a guessed volume
 *   - currency honesty: quote currency must equal the account currency
 *     (no invented FX conversion)
 *   - below-minimum: rounding UP to minLot would exceed the risk budget —
 *     typed rejection, never a round-up
 *   - step normalization rounds DOWN (conservative for risk)
 */

const USER = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';

const EURUSD_SPEC: BrokerInstrument = {
  symbol: 'EURUSD',
  description: 'Euro vs US Dollar',
  digits: 5,
  minLot: '0.01',
  maxLot: '10.00',
  lotStep: '0.01',
  contractSize: '100000',
};

const profileRow = (overrides: Partial<RiskProfile> = {}): RiskProfile =>
  ({
    userId: USER,
    maxTradeRiskPercent: '2.00',
    maxPositionSizeLot: '1.0000',
    ...overrides,
  }) as RiskProfile;

const accountState = (
  overrides: Partial<{
    balance: string;
    equity: string;
    freeMargin: string;
    currency: string;
  }> = {},
) => ({
  balance: '10000.00',
  equity: '10000.00',
  freeMargin: '9500.00',
  currency: 'USD',
  ...overrides,
});

const geometry = (
  overrides: Partial<{
    contractSize: ExactDecimal | null;
    freshQuote: ExactDecimal | null;
    instrumentSpec: BrokerInstrument | null;
  }> = {},
) => ({
  contractSize: ExactDecimal.parse('100000'),
  freshQuote: ExactDecimal.parse('1.08500'),
  quoteRef: { source: 'M1' },
  instrumentSpec: EURUSD_SPEC,
  ...overrides,
});

describe('PositionSizingService — deterministic fail-closed sizing (Round 6 §4)', () => {
  let service: PositionSizingService;
  let brokerService: { getBrokerAccountState: jest.Mock };
  let orderGeometry: { resolveOrderGeometry: jest.Mock };
  let profileRepo: { findOne: jest.Mock };

  const baseParams = (
    overrides: Partial<{
      userId: string;
      brokerConnectionId: string;
      instrument: string;
      direction: 'BUY' | 'SELL';
      entryType: 'MARKET' | 'LIMIT';
      requestedEntryPrice: string | null;
      stopLoss: string | null;
    }> = {},
  ) => ({
    userId: USER,
    brokerConnectionId: CONN,
    instrument: 'EURUSD',
    direction: 'BUY' as const,
    entryType: 'MARKET' as const,
    requestedEntryPrice: null,
    stopLoss: '1.07500',
    ...overrides,
  });

  beforeEach(() => {
    brokerService = {
      getBrokerAccountState: jest.fn().mockResolvedValue(accountState()),
    };
    orderGeometry = {
      resolveOrderGeometry: jest.fn().mockResolvedValue(geometry()),
    };
    profileRepo = { findOne: jest.fn().mockResolvedValue(profileRow()) };
    service = new PositionSizingService(
      brokerService as unknown as BrokerService,
      orderGeometry as unknown as RiskOrderGeometryService,
      profileRepo as never,
    );
  });

  // ─── The sizing math (exact strings, never floats) ──────────────────────

  describe('sizing math', () => {
    it('computes risk-budget lots, clamps and normalizes exactly', async () => {
      // equity 10000 × 2% = 200 risk; SL distance |1.085 − 1.075| = 0.010;
      // risk per lot = 0.010 × 100000 = 1000 → 200/1000 = 0.20 lots;
      // capital = 0.20 × 100000 × 1.085 = 21700.
      const sized = await service.sizePosition(baseParams());

      expect(sized.lots).toBe('0.2');
      expect(sized.allocatedCapital).toBe('21700');
      expect(sized.accountCurrency).toBe('USD');
      expect(sized.entryPrice).toBe('1.085');
      expect(sized.inputs.riskAmount).toBe('200');
      expect(sized.inputs.stopLossDistance).toBe('0.01');
      expect(sized.inputs.lotsByRiskBudget).toBe('0.2');
      expect(sized.inputs.entryPriceSource).toBe('MARKET_QUOTE');
      expect(sized.inputs.contractSize).toBe('100000');
      expect(sized.inputs.minLot).toBe('0.01');
      expect(sized.inputs.computedAt).toBeTruthy();
    });

    it('normalizes DOWN to the instrument volume step (0.2567 → 0.25 at step 0.01)', async () => {
      // risk 200 / (0.00775 × 100000) = 0.25806451... → step-down → 0.25
      const sized = await service.sizePosition(baseParams({ stopLoss: '1.07725' }));
      expect(sized.lots).toBe('0.25');
    });

    it('clamps to the instrument maxLot', async () => {
      orderGeometry.resolveOrderGeometry.mockResolvedValue(
        geometry({ instrumentSpec: { ...EURUSD_SPEC, maxLot: '0.10' } }),
      );
      const sized = await service.sizePosition(baseParams());
      expect(sized.lots).toBe('0.1');
    });

    it('clamps to the profile maxPositionSizeLot', async () => {
      profileRepo.findOne.mockResolvedValue(profileRow({ maxPositionSizeLot: '0.1000' }));
      const sized = await service.sizePosition(baseParams());
      expect(sized.lots).toBe('0.1');
      expect(sized.inputs.profileMaxPositionSizeLot).toBe('0.1');
    });

    it('uses the REQUESTED price for LIMIT entries', async () => {
      const sized = await service.sizePosition({
        ...baseParams(),
        entryType: 'LIMIT',
        requestedEntryPrice: '1.08000',
        stopLoss: '1.07000',
      });
      expect(sized.entryPrice).toBe('1.08');
      expect(sized.inputs.entryPriceSource).toBe('REQUESTED_LIMIT');
      // risk 200 / (0.01 × 100000) = 0.2 lots; capital = 0.2 × 100000 × 1.08
      expect(sized.lots).toBe('0.2');
      expect(sized.allocatedCapital).toBe('21600');
    });
  });

  // ─── Typed fail-closed matrix — a missing input NEVER guesses a volume ──

  describe('typed fail-closed guards', () => {
    it('EQUITY_UNPROVABLE when no authoritative account state exists (§1c)', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue(null);
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'EQUITY_UNPROVABLE',
      });
    });

    it('EQUITY_UNPROVABLE when equity is not a provable positive decimal', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue(accountState({ equity: '0' }));
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'EQUITY_UNPROVABLE',
      });
    });

    it('FREE_MARGIN_UNPROVABLE when free margin is unparseable', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue(accountState({ freeMargin: 'n/a' }));
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'FREE_MARGIN_UNPROVABLE',
      });
    });

    it('ACCOUNT_CURRENCY_UNPROVABLE for a non-ISO currency', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue(accountState({ currency: 'us' }));
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'ACCOUNT_CURRENCY_UNPROVABLE',
      });
    });

    it('RISK_PROFILE_UNPROVABLE when no profile row exists', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'RISK_PROFILE_UNPROVABLE',
      });
    });

    it('RISK_BUDGET_UNPARSEABLE when the risk percent is not provable', async () => {
      profileRepo.findOne.mockResolvedValue(profileRow({ maxTradeRiskPercent: '0' }));
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'RISK_BUDGET_UNPARSEABLE',
      });
    });

    it('CONTRACT_SIZE_UNPROVABLE when the seam cannot prove it', async () => {
      orderGeometry.resolveOrderGeometry.mockResolvedValue(
        geometry({ contractSize: null, instrumentSpec: null }),
      );
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'CONTRACT_SIZE_UNPROVABLE',
      });
    });

    it('INSTRUMENT_SPEC_UNPROVABLE when the spec is missing', async () => {
      orderGeometry.resolveOrderGeometry.mockResolvedValue(geometry({ instrumentSpec: null }));
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'INSTRUMENT_SPEC_UNPROVABLE',
      });
    });

    it('ENTRY_PRICE_UNPROVABLE for a MARKET entry without a fresh quote', async () => {
      orderGeometry.resolveOrderGeometry.mockResolvedValue(geometry({ freshQuote: null }));
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'ENTRY_PRICE_UNPROVABLE',
      });
    });

    it('STOP_LOSS_REQUIRED when the decision carries no stop', async () => {
      await expect(service.sizePosition(baseParams({ stopLoss: null }))).rejects.toMatchObject({
        code: 'STOP_LOSS_REQUIRED',
      });
    });

    it('STOP_LOSS_DISTANCE_INVALID when the stop equals the entry', async () => {
      await expect(service.sizePosition(baseParams({ stopLoss: '1.08500' }))).rejects.toMatchObject(
        { code: 'STOP_LOSS_DISTANCE_INVALID' },
      );
    });

    it('CURRENCY_MISMATCH when the instrument quotes in a different currency (no invented FX)', async () => {
      await expect(
        service.sizePosition(baseParams({ instrument: 'GBPJPY' })),
      ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    });

    it('CURRENCY_MISMATCH for non-standard symbols whose quote currency cannot be proven', async () => {
      await expect(service.sizePosition(baseParams({ instrument: 'XAU' }))).rejects.toMatchObject({
        code: 'CURRENCY_MISMATCH',
      });
    });

    it('POSITION_SIZE_BELOW_MINIMUM — rounding UP to minLot would exceed the risk budget', async () => {
      // equity 1000 × 2% = 20 risk; per lot = 0.01 × 100000 = 1000 → 0.02
      // lots — a nonzero volume below the 0.10 minimum. NEVER rounded up
      // (rounding up would exceed the risk budget).
      brokerService.getBrokerAccountState.mockResolvedValue(
        accountState({ equity: '1000.00', balance: '1000.00' }),
      );
      orderGeometry.resolveOrderGeometry.mockResolvedValue(
        geometry({ instrumentSpec: { ...EURUSD_SPEC, minLot: '0.10' } }),
      );
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'POSITION_SIZE_BELOW_MINIMUM',
      });
    });

    it('POSITION_SIZE_ZERO when the risk budget affords nothing', async () => {
      brokerService.getBrokerAccountState.mockResolvedValue(
        accountState({ equity: '0.50', balance: '0.50' }),
      );
      await expect(service.sizePosition(baseParams())).rejects.toMatchObject({
        code: 'POSITION_SIZE_ZERO',
      });
    });
  });

  // ─── Error shape ────────────────────────────────────────────────────────

  it('PositionSizingError carries the stable machine code + message', async () => {
    brokerService.getBrokerAccountState.mockResolvedValue(null);
    try {
      await service.sizePosition(baseParams());
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PositionSizingError);
      expect((err as PositionSizingError).code).toBe('EQUITY_UNPROVABLE');
      expect((err as Error).message).toContain('EQUITY_UNPROVABLE');
    }
  });
});
