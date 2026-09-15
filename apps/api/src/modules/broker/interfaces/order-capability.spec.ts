import {
  assertOrderWithinCapabilities,
  OrderCapabilityDeclaration,
  OrderCapabilityError,
} from './order-capability';

/**
 * Round 6 live-execution completion (§7) — the ORDER CAPABILITY CONTRACT.
 *
 * Matrix:
 *   - a request within the declaration passes (pure, no adapter I/O)
 *   - an undeclared order kind → typed ORDER_KIND_NOT_SUPPORTED
 *   - LIMIT without limitPrice → typed LIMIT_PRICE_REQUIRED
 *   - STOP without stopPrice → typed STOP_PRICE_REQUIRED
 *   - STOP_LIMIT needs BOTH prices
 *   - undefined orderKind defaults to MARKET (the pipeline's only kind)
 *   - the four PRODUCTION adapter declarations match their documented
 *     matrices (OANDA lacks STOP_LIMIT; cTrader defers MARKET SL/TP)
 */

const fullDeclaration = (overrides: Partial<OrderCapabilityDeclaration> = {}): OrderCapabilityDeclaration => ({
  brokerId: 'test-broker',
  supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'],
  requirements: {
    MARKET: { limitPriceRequired: false, stopPriceRequired: false },
    LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
    STOP: { limitPriceRequired: false, stopPriceRequired: true },
    STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
  },
  marketSlTpAttachedAtPlacement: true,
  ...overrides,
});

describe('assertOrderWithinCapabilities (Round 6 §7)', () => {
  it('passes a MARKET request (the pipeline signal path)', () => {
    expect(() =>
      assertOrderWithinCapabilities({ orderKind: 'MARKET' }, fullDeclaration()),
    ).not.toThrow();
  });

  it('passes an undefined orderKind as MARKET (default of the order model)', () => {
    expect(() =>
      assertOrderWithinCapabilities({ orderKind: undefined }, fullDeclaration()),
    ).not.toThrow();
  });

  it('passes a fully-formed LIMIT request', () => {
    expect(() =>
      assertOrderWithinCapabilities(
        { orderKind: 'LIMIT', limitPrice: '1.08500' },
        fullDeclaration(),
      ),
    ).not.toThrow();
  });

  it('ORDER_KIND_NOT_SUPPORTED for an undeclared kind (typed, fail-closed)', () => {
    const declaration = fullDeclaration({
      supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP'], // OANDA shape
    });
    try {
      assertOrderWithinCapabilities(
        { orderKind: 'STOP_LIMIT', limitPrice: '1.08', stopPrice: '1.09' },
        declaration,
      );
      throw new Error('expected a typed violation');
    } catch (err) {
      expect(err).toBeInstanceOf(OrderCapabilityError);
      expect((err as OrderCapabilityError).code).toBe('ORDER_KIND_NOT_SUPPORTED');
      expect((err as OrderCapabilityError).brokerId).toBe('test-broker');
      expect((err as Error).message).toContain('STOP_LIMIT');
      expect((err as Error).message).toContain('MARKET, LIMIT, STOP');
    }
  });

  it('LIMIT_PRICE_REQUIRED for a LIMIT without a positive limitPrice', () => {
    for (const limitPrice of [undefined, '', '0', '-1', 'abc']) {
      try {
        assertOrderWithinCapabilities(
          { orderKind: 'LIMIT', limitPrice: limitPrice as string | undefined },
          fullDeclaration(),
        );
        throw new Error('expected a typed violation');
      } catch (err) {
        expect((err as OrderCapabilityError).code).toBe('LIMIT_PRICE_REQUIRED');
      }
    }
  });

  it('STOP_PRICE_REQUIRED for a STOP without a positive stopPrice', () => {
    try {
      assertOrderWithinCapabilities(
        { orderKind: 'STOP', stopPrice: undefined },
        fullDeclaration(),
      );
      throw new Error('expected a typed violation');
    } catch (err) {
      expect((err as OrderCapabilityError).code).toBe('STOP_PRICE_REQUIRED');
    }
  });

  it('STOP_LIMIT requires BOTH prices (either missing fails closed)', () => {
    expect(() =>
      assertOrderWithinCapabilities(
        { orderKind: 'STOP_LIMIT', limitPrice: '1.08', stopPrice: undefined },
        fullDeclaration(),
      ),
    ).toThrow(OrderCapabilityError);
    expect(() =>
      assertOrderWithinCapabilities(
        { orderKind: 'STOP_LIMIT', limitPrice: undefined, stopPrice: '1.09' },
        fullDeclaration(),
      ),
    ).toThrow(OrderCapabilityError);
    expect(() =>
      assertOrderWithinCapabilities(
        { orderKind: 'STOP_LIMIT', limitPrice: '1.08', stopPrice: '1.09' },
        fullDeclaration(),
      ),
    ).not.toThrow();
  });

  it('MARKET never requires prices even on a STOP_LIMIT-capable adapter', () => {
    expect(() =>
      assertOrderWithinCapabilities({ orderKind: 'MARKET' }, fullDeclaration()),
    ).not.toThrow();
  });
});

describe('the four PRODUCTION adapter declarations (Round 6 §7/§11 truth matrix)', () => {
  const { MetaTraderAdapter } = require('../adapters/metatrader.adapter');
  const { OandaAdapter } = require('../adapters/oanda/oanda.adapter');
  const { CTraderAdapter } = require('../adapters/ctrader/ctrader.adapter');
  const { PaperBrokerAdapter } = require('../adapters/paper-broker.adapter');

  const declarationOf = (AdapterClass: new (...args: never[]) => { getOrderCapabilities(): OrderCapabilityDeclaration }): OrderCapabilityDeclaration => {
    // Constructors take collaborators; the declaration is static truth —
    // construct with undefined deps (never touched by getOrderCapabilities).
    const instance = new AdapterClass(...(([] as unknown[]) as never[]));
    return instance.getOrderCapabilities();
  };

  it('metatrader5: all four kinds, MARKET SL/TP at placement', () => {
    const d = declarationOf(MetaTraderAdapter as never);
    expect(d.brokerId).toBe('metatrader5');
    expect([...d.supportedOrderKinds].sort()).toEqual(['LIMIT', 'MARKET', 'STOP', 'STOP_LIMIT']);
    expect(d.marketSlTpAttachedAtPlacement).toBe(true);
  });

  it('oanda: STOP_LIMIT NOT declared (v20 has no stop-limit — fail-closed, never downgraded)', () => {
    const d = declarationOf(OandaAdapter as never);
    expect(d.brokerId).toBe('oanda');
    expect(d.supportedOrderKinds).toEqual(['MARKET', 'LIMIT', 'STOP']);
    expect(d.supportedOrderKinds).not.toContain('STOP_LIMIT');
    expect(d.marketSlTpAttachedAtPlacement).toBe(true);
    // The declared gap is ENFORCED: a STOP_LIMIT request fails closed.
    expect(() =>
      assertOrderWithinCapabilities(
        { orderKind: 'STOP_LIMIT', limitPrice: '1.08', stopPrice: '1.09' },
        d,
      ),
    ).toThrow(OrderCapabilityError);
  });

  it('ctrader: all four kinds, MARKET SL/TP DEFERRED to the filled position (§8 covers the shape)', () => {
    const d = declarationOf(CTraderAdapter as never);
    expect(d.brokerId).toBe('ctrader');
    expect([...d.supportedOrderKinds].sort()).toEqual(['LIMIT', 'MARKET', 'STOP', 'STOP_LIMIT']);
    expect(d.marketSlTpAttachedAtPlacement).toBe(false);
  });

  it('paper-broker: all four kinds, MARKET SL/TP at placement', () => {
    const d = declarationOf(PaperBrokerAdapter as never);
    expect(d.brokerId).toBe('paper-broker');
    expect([...d.supportedOrderKinds].sort()).toEqual(['LIMIT', 'MARKET', 'STOP', 'STOP_LIMIT']);
    expect(d.marketSlTpAttachedAtPlacement).toBe(true);
  });

  it('every declaration is COMPLETE (all four kinds have a requirement entry)', () => {
    for (const AdapterClass of [MetaTraderAdapter, OandaAdapter, CTraderAdapter, PaperBrokerAdapter]) {
      const d = declarationOf(AdapterClass as never);
      for (const kind of ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'] as const) {
        expect(d.requirements[kind]).toBeDefined();
      }
      // A declared kind must pass its own requirement shape.
      for (const kind of d.supportedOrderKinds) {
        if (kind === 'MARKET') {
          expect(() =>
            assertOrderWithinCapabilities({ orderKind: kind }, d),
          ).not.toThrow();
        }
      }
    }
  });
});
