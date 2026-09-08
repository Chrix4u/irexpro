import { TradeStatus } from '../entities/trade.entity';
import { TradeStateMachine } from './trade-state-machine';

/**
 * Exhaustive transition-table validation for the trade/position state machine
 * (centralizes the previously scattered repo.update() calls).
 */
describe('TradeStateMachine', () => {
  describe('canTransition — every legal edge', () => {
    const allowed: Array<[TradeStatus, TradeStatus]> = [
      [TradeStatus.PENDING, TradeStatus.OPEN],
      [TradeStatus.PENDING, TradeStatus.REJECTED],
      [TradeStatus.PENDING, TradeStatus.CANCELLED],
      [TradeStatus.PENDING, TradeStatus.RECONCILIATION_PENDING],
      [TradeStatus.OPEN, TradeStatus.CLOSED],
      [TradeStatus.OPEN, TradeStatus.RECONCILIATION_PENDING],
      [TradeStatus.RECONCILIATION_PENDING, TradeStatus.OPEN],
      [TradeStatus.RECONCILIATION_PENDING, TradeStatus.CLOSED],
    ];

    it.each(allowed)('%s → %s is allowed', (from, to) => {
      expect(TradeStateMachine.canTransition(from, to)).toBe(true);
    });
  });

  describe('terminal states have NO outgoing edges', () => {
    it.each([TradeStatus.CLOSED, TradeStatus.REJECTED, TradeStatus.CANCELLED] as TradeStatus[])(
      '%s cannot transition anywhere',
      (from) => {
        for (const to of Object.values(TradeStatus)) {
          expect(TradeStateMachine.canTransition(from, to)).toBe(false);
        }
      },
    );
  });

  describe('rejects illegal edges', () => {
    const illegal: Array<[TradeStatus, TradeStatus]> = [
      [TradeStatus.PENDING, TradeStatus.CLOSED], // a position cannot close before opening
      [TradeStatus.OPEN, TradeStatus.PENDING],
      [TradeStatus.OPEN, TradeStatus.REJECTED], // a filled position is closed, not rejected
      [TradeStatus.OPEN, TradeStatus.CANCELLED], // open positions are CLOSED, never CANCELLED
      [TradeStatus.RECONCILIATION_PENDING, TradeStatus.REJECTED],
      [TradeStatus.RECONCILIATION_PENDING, TradeStatus.PENDING],
      [TradeStatus.CLOSED, TradeStatus.OPEN],
      [TradeStatus.REJECTED, TradeStatus.PENDING],
      [TradeStatus.CANCELLED, TradeStatus.OPEN],
    ];

    it.each(illegal)('%s → %s is rejected', (from, to) => {
      expect(TradeStateMachine.canTransition(from, to)).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('throws with from → to in the message', () => {
      expect(() =>
        TradeStateMachine.assertTransition(TradeStatus.OPEN, TradeStatus.REJECTED),
      ).toThrow('Invalid trade transition: OPEN → REJECTED');
    });

    it('does NOT throw for legal transitions', () => {
      expect(() =>
        TradeStateMachine.assertTransition(TradeStatus.PENDING, TradeStatus.OPEN),
      ).not.toThrow();
    });
  });

  describe('fail-closed for unknown/null states', () => {
    it('null/undefined can never transition and never throws silently', () => {
      expect(TradeStateMachine.canTransition(null, TradeStatus.OPEN)).toBe(false);
      expect(() => TradeStateMachine.assertTransition(undefined, TradeStatus.OPEN)).toThrow(
        'Invalid trade transition: UNKNOWN → OPEN',
      );
    });

    it('isTerminal(null) is false', () => {
      expect(TradeStateMachine.isTerminal(null)).toBe(false);
    });
  });

  describe('isPositionOpen — FAIL-CLOSED market-exposure gate', () => {
    it('only OPEN counts as live market exposure', () => {
      expect(TradeStateMachine.isPositionOpen(TradeStatus.OPEN)).toBe(true);
    });

    it.each([
      TradeStatus.PENDING,
      TradeStatus.RECONCILIATION_PENDING,
      TradeStatus.CLOSED,
      TradeStatus.REJECTED,
      TradeStatus.CANCELLED,
    ] as TradeStatus[])('%s is NOT an open position (conservative risk accounting)', (status) => {
      expect(TradeStateMachine.isPositionOpen(status)).toBe(false);
    });

    it('null/undefined is NOT open (fail-closed)', () => {
      expect(TradeStateMachine.isPositionOpen(null)).toBe(false);
      expect(TradeStateMachine.isPositionOpen(undefined)).toBe(false);
    });
  });
});
