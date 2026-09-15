import {
  SessionStateMachineError,
  TradingSessionStateMachine,
} from './trading-session-state-machine';
import { TradingSessionStatus } from './trading-session.entity';

/**
 * TradingSessionStateMachine (Round 6 §16) — the autonomous session
 * lifecycle. Before Round 6, PAUSED / SUSPENDED_RISK_LIMIT /
 * SUSPENDED_BROKER existed in the enum but NO production path ever SET
 * them. This machine pins the full legal graph.
 */
describe('TradingSessionStateMachine (§16)', () => {
  it('ACTIVE may degrade: PAUSE, SUSPEND_RISK_LIMIT, SUSPEND_BROKER, END', () => {
    for (const to of [
      TradingSessionStatus.PAUSED,
      TradingSessionStatus.SUSPENDED_RISK_LIMIT,
      TradingSessionStatus.SUSPENDED_BROKER,
      TradingSessionStatus.ENDED,
    ]) {
      expect(TradingSessionStateMachine.canTransition(TradingSessionStatus.ACTIVE, to)).toBe(true);
    }
  });

  it('every suspended state may RESUME (ACTIVE) or END — the degradation is not a one-way trap', () => {
    for (const from of [
      TradingSessionStatus.PAUSED,
      TradingSessionStatus.SUSPENDED_RISK_LIMIT,
      TradingSessionStatus.SUSPENDED_BROKER,
    ]) {
      expect(TradingSessionStateMachine.canTransition(from, TradingSessionStatus.ACTIVE)).toBe(true);
      expect(TradingSessionStateMachine.canTransition(from, TradingSessionStatus.ENDED)).toBe(true);
    }
  });

  it('ENDED is terminal — nothing leaves it', () => {
    for (const to of Object.values(TradingSessionStatus)) {
      expect(TradingSessionStateMachine.canTransition(TradingSessionStatus.ENDED, to)).toBe(false);
    }
  });

  it('a suspension may never hop DIRECTLY to another suspension (resume first)', () => {
    expect(
      TradingSessionStateMachine.canTransition(
        TradingSessionStatus.SUSPENDED_RISK_LIMIT,
        TradingSessionStatus.SUSPENDED_BROKER,
      ),
    ).toBe(false);
    expect(
      TradingSessionStateMachine.canTransition(
        TradingSessionStatus.SUSPENDED_BROKER,
        TradingSessionStatus.PAUSED,
      ),
    ).toBe(false);
    expect(
      TradingSessionStateMachine.canTransition(TradingSessionStatus.PAUSED, TradingSessionStatus.SUSPENDED_BROKER),
    ).toBe(false);
  });

  it('assertTransition throws the typed error on an illegal hop', () => {
    expect(() =>
      TradingSessionStateMachine.assertTransition(
        TradingSessionStatus.ENDED,
        TradingSessionStatus.ACTIVE,
      ),
    ).toThrow(SessionStateMachineError);
    expect(() =>
      TradingSessionStateMachine.assertTransition(
        TradingSessionStatus.ENDED,
        TradingSessionStatus.ACTIVE,
      ),
    ).toThrow('ENDED → ACTIVE');
  });

  it('assertTransition passes every legal edge', () => {
    expect(() =>
      TradingSessionStateMachine.assertTransition(
        TradingSessionStatus.ACTIVE,
        TradingSessionStatus.SUSPENDED_RISK_LIMIT,
      ),
    ).not.toThrow();
    expect(() =>
      TradingSessionStateMachine.assertTransition(
        TradingSessionStatus.SUSPENDED_RISK_LIMIT,
        TradingSessionStatus.ACTIVE,
      ),
    ).not.toThrow();
  });

  it('the table covers every enum member (no silent undefined rows)', () => {
    const table = TradingSessionStateMachine.transitions();
    for (const status of Object.values(TradingSessionStatus)) {
      expect(Array.isArray(table[status])).toBe(true);
    }
  });
});
