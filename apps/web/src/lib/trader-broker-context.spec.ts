import {
  getSelectedTraderBrokerId,
  reconcileSelectedTraderBrokerId,
  setSelectedTraderBrokerId,
} from './trader-broker-context';

describe('trader broker context', () => {
  afterEach(() => {
    setSelectedTraderBrokerId(null);
  });

  it('preserves an explicit broker selection while no trading session is active', () => {
    setSelectedTraderBrokerId('ctrader-eur');

    expect(
      reconcileSelectedTraderBrokerId({
        brokerIds: ['paper-usd', 'ctrader-eur'],
        primaryBrokerId: 'paper-usd',
      }),
    ).toBe('ctrader-eur');
    expect(getSelectedTraderBrokerId()).toBe('ctrader-eur');
  });

  it('pins the context to the active session broker when execution authority exists', () => {
    setSelectedTraderBrokerId('paper-usd');

    expect(
      reconcileSelectedTraderBrokerId({
        brokerIds: ['paper-usd', 'ctrader-eur'],
        sessionBrokerId: 'ctrader-eur',
        primaryBrokerId: 'paper-usd',
      }),
    ).toBe('ctrader-eur');
    expect(getSelectedTraderBrokerId()).toBe('ctrader-eur');
  });

  it('falls back to the primary broker when the previous selection no longer exists', () => {
    setSelectedTraderBrokerId('removed-broker');

    expect(
      reconcileSelectedTraderBrokerId({
        brokerIds: ['ctrader-eur'],
        primaryBrokerId: 'ctrader-eur',
      }),
    ).toBe('ctrader-eur');
    expect(getSelectedTraderBrokerId()).toBe('ctrader-eur');
  });
});
