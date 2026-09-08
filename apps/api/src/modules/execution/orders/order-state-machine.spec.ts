import { OrderStatus, ORDER_STATUSES } from './order.enums';
import { OrderStateMachine } from './order-state-machine';

/**
 * Exhaustive transition-table validation for the order state machine.
 * Mirrors the Sprint 50 broker-authorization machine spec pattern.
 */
describe('OrderStateMachine', () => {
  describe('canTransition — every allowed edge', () => {
    const allowed: Array<[OrderStatus, OrderStatus]> = [
      // CREATED
      [OrderStatus.CREATED, OrderStatus.SUBMITTED],
      [OrderStatus.CREATED, OrderStatus.REJECTED],
      [OrderStatus.CREATED, OrderStatus.CANCELLED],
      // SUBMITTED
      [OrderStatus.SUBMITTED, OrderStatus.ACKNOWLEDGED],
      [OrderStatus.SUBMITTED, OrderStatus.PARTIALLY_FILLED],
      [OrderStatus.SUBMITTED, OrderStatus.FILLED],
      [OrderStatus.SUBMITTED, OrderStatus.REJECTED],
      [OrderStatus.SUBMITTED, OrderStatus.CANCELLED],
      [OrderStatus.SUBMITTED, OrderStatus.EXPIRED],
      [OrderStatus.SUBMITTED, OrderStatus.RECONCILIATION_PENDING],
      // ACKNOWLEDGED
      [OrderStatus.ACKNOWLEDGED, OrderStatus.PARTIALLY_FILLED],
      [OrderStatus.ACKNOWLEDGED, OrderStatus.FILLED],
      [OrderStatus.ACKNOWLEDGED, OrderStatus.REJECTED],
      [OrderStatus.ACKNOWLEDGED, OrderStatus.CANCELLED],
      [OrderStatus.ACKNOWLEDGED, OrderStatus.EXPIRED],
      [OrderStatus.ACKNOWLEDGED, OrderStatus.RECONCILIATION_PENDING],
      // PARTIALLY_FILLED
      [OrderStatus.PARTIALLY_FILLED, OrderStatus.FILLED],
      [OrderStatus.PARTIALLY_FILLED, OrderStatus.CANCELLED],
      [OrderStatus.PARTIALLY_FILLED, OrderStatus.REJECTED],
      [OrderStatus.PARTIALLY_FILLED, OrderStatus.EXPIRED],
      [OrderStatus.PARTIALLY_FILLED, OrderStatus.RECONCILIATION_PENDING],
      // RECONCILIATION_PENDING resolves to provider-observed state
      [OrderStatus.RECONCILIATION_PENDING, OrderStatus.ACKNOWLEDGED],
      [OrderStatus.RECONCILIATION_PENDING, OrderStatus.PARTIALLY_FILLED],
      [OrderStatus.RECONCILIATION_PENDING, OrderStatus.FILLED],
      [OrderStatus.RECONCILIATION_PENDING, OrderStatus.REJECTED],
      [OrderStatus.RECONCILIATION_PENDING, OrderStatus.CANCELLED],
      [OrderStatus.RECONCILIATION_PENDING, OrderStatus.EXPIRED],
    ];

    it.each(allowed)('%s → %s is allowed', (from, to) => {
      expect(OrderStateMachine.canTransition(from, to)).toBe(true);
    });

    it('has the full set of declared allowed edges (27 total)', () => {
      expect(allowed.length).toBe(27);
    });
  });

  describe('canTransition — terminal states have NO outgoing edges', () => {
    const terminals: OrderStatus[] = [
      OrderStatus.FILLED,
      OrderStatus.REJECTED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
    ];

    it.each(terminals)('%s is terminal and cannot transition anywhere', (from) => {
      for (const to of ORDER_STATUSES) {
        expect(OrderStateMachine.canTransition(from, to)).toBe(false);
      }
    });
  });

  describe('canTransition — rejects illegal edges', () => {
    const illegal: Array<[OrderStatus, OrderStatus]> = [
      [OrderStatus.CREATED, OrderStatus.FILLED], // must be submitted first
      [OrderStatus.CREATED, OrderStatus.PARTIALLY_FILLED],
      [OrderStatus.CREATED, OrderStatus.ACKNOWLEDGED],
      [OrderStatus.CREATED, OrderStatus.EXPIRED],
      [OrderStatus.CREATED, OrderStatus.RECONCILIATION_PENDING],
      [OrderStatus.SUBMITTED, OrderStatus.CREATED], // no backwards
      [OrderStatus.ACKNOWLEDGED, OrderStatus.SUBMITTED],
      [OrderStatus.PARTIALLY_FILLED, OrderStatus.ACKNOWLEDGED],
      [OrderStatus.FILLED, OrderStatus.PARTIALLY_FILLED], // terminal
      [OrderStatus.REJECTED, OrderStatus.SUBMITTED], // terminal
      [OrderStatus.CANCELLED, OrderStatus.FILLED], // terminal
      [OrderStatus.EXPIRED, OrderStatus.FILLED], // terminal
      [OrderStatus.RECONCILIATION_PENDING, OrderStatus.SUBMITTED],
      [OrderStatus.RECONCILIATION_PENDING, OrderStatus.CREATED],
    ];

    it.each(illegal)('%s → %s is rejected', (from, to) => {
      expect(OrderStateMachine.canTransition(from, to)).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('throws with from → to in the message for illegal transitions', () => {
      expect(() =>
        OrderStateMachine.assertTransition(OrderStatus.FILLED, OrderStatus.CANCELLED),
      ).toThrow('Invalid order transition: FILLED → CANCELLED');
    });

    it('does NOT throw for legal transitions', () => {
      expect(() =>
        OrderStateMachine.assertTransition(OrderStatus.CREATED, OrderStatus.SUBMITTED),
      ).not.toThrow();
    });
  });

  describe('fail-closed semantics for unknown/null states', () => {
    it('null from-state can never transition', () => {
      for (const to of ORDER_STATUSES) {
        expect(OrderStateMachine.canTransition(null, to)).toBe(false);
      }
      expect(() => OrderStateMachine.assertTransition(null, OrderStatus.SUBMITTED)).toThrow(
        'Invalid order transition: UNKNOWN',
      );
    });

    it('undefined from-state can never transition', () => {
      expect(OrderStateMachine.canTransition(undefined, OrderStatus.FILLED)).toBe(false);
    });

    it('isTerminal(null/undefined) is false (fail-closed)', () => {
      expect(OrderStateMachine.isTerminal(null)).toBe(false);
      expect(OrderStateMachine.isTerminal(undefined)).toBe(false);
    });

    it('isWorking(null/undefined) is false (fail-closed)', () => {
      expect(OrderStateMachine.isWorking(null)).toBe(false);
      expect(OrderStateMachine.isWorking(undefined)).toBe(false);
    });
  });

  describe('isTerminal / isWorking', () => {
    it.each([
      OrderStatus.FILLED,
      OrderStatus.REJECTED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
    ] as OrderStatus[])('%s is terminal and NOT working', (status) => {
      expect(OrderStateMachine.isTerminal(status)).toBe(true);
      expect(OrderStateMachine.isWorking(status)).toBe(false);
    });

    it.each([
      OrderStatus.CREATED,
      OrderStatus.SUBMITTED,
      OrderStatus.ACKNOWLEDGED,
      OrderStatus.PARTIALLY_FILLED,
    ] as OrderStatus[])('%s is working and NOT terminal', (status) => {
      expect(OrderStateMachine.isWorking(status)).toBe(true);
      expect(OrderStateMachine.isTerminal(status)).toBe(false);
    });

    it('RECONCILIATION_PENDING is neither working nor terminal (uncertain)', () => {
      expect(OrderStateMachine.isWorking(OrderStatus.RECONCILIATION_PENDING)).toBe(false);
      expect(OrderStateMachine.isTerminal(OrderStatus.RECONCILIATION_PENDING)).toBe(false);
    });
  });

  describe('isFillable', () => {
    it.each([
      OrderStatus.SUBMITTED,
      OrderStatus.ACKNOWLEDGED,
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.RECONCILIATION_PENDING,
    ] as OrderStatus[])('%s accepts fills', (status) => {
      expect(OrderStateMachine.isFillable(status)).toBe(true);
    });

    it.each([
      OrderStatus.CREATED,
      OrderStatus.FILLED,
      OrderStatus.REJECTED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
    ] as OrderStatus[])('%s rejects fills', (status) => {
      expect(OrderStateMachine.isFillable(status)).toBe(false);
    });

    it('null/undefined never accepts fills (fail-closed)', () => {
      expect(OrderStateMachine.isFillable(null)).toBe(false);
      expect(OrderStateMachine.isFillable(undefined)).toBe(false);
    });
  });
});
