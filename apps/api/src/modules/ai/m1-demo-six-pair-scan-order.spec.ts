import { orderM1DemoSixPairScan } from './m1-demo-six-pair-scan-order';
import {
  M1_TACTICAL_ROLLOUT_POLICY_V1,
  M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW,
  M1_TACTICAL_ROLLOUT_POLICY_V8_SIX_PAIR_FEE_SHADOW,
  M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_TWO_FEE_SHADOW,
} from './m1-tactical-scheduler.service';

const DEMO = M1_TACTICAL_ROLLOUT_POLICY_V8_SIX_PAIR_FEE_SHADOW;
const SLOT = new Date('2026-11-11T00:42:00.000Z');
const eligible = [...DEMO.demoEntryInstruments!];
const input = (decisionTime = SLOT) => ({
  phase: DEMO.phase,
  policyInstruments: DEMO.instruments,
  demoEntryInstruments: DEMO.demoEntryInstruments,
  decisionTime,
});

describe('restored six-pair DEMO M1 scan priority, no new order authority', () => {
  it('evaluates USDJPY first without reducing or duplicating six instrument evaluations', () => {
    const order = orderM1DemoSixPairScan(input());
    expect(order[0]).toBe('USDJPY');
    expect(order).toHaveLength(6);
    expect(new Set(order)).toEqual(new Set(eligible));
    expect([...DEMO.demoEntryInstruments!]).toEqual(eligible);
    expect([...DEMO.instruments]).toEqual([
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'AUDUSD',
      'USDCAD',
      'USDCHF',
    ]);
  });

  it('rotates the other five pairs fairly across five complete minute slots', () => {
    const slots = Array.from({ length: 5 }, (_, i) =>
      orderM1DemoSixPairScan(input(new Date(SLOT.getTime() + i * 60_000))),
    );
    const firstAfterUsdJpy = slots.map((order) => order[1]);
    expect(new Set(firstAfterUsdJpy)).toEqual(new Set(eligible.filter((x) => x !== 'USDJPY')));
    for (const order of slots) {
      expect(order[0]).toBe('USDJPY');
      expect(new Set(order)).toEqual(new Set(eligible));
    }
  });

  it('uses identical order for repeated same-minute wakeups without mutating config', () => {
    const first = orderM1DemoSixPairScan(input(new Date('2026-11-11T00:42:00Z')));
    const second = orderM1DemoSixPairScan(input(new Date('2026-11-11T00:42:45Z')));
    expect(first).toEqual(second);
    first.reverse();
    expect(orderM1DemoSixPairScan(input())).toEqual(second);
    expect(DEMO.demoEntryInstruments).toEqual(eligible);
    expect(Object.isFrozen(DEMO.demoEntryInstruments)).toBe(true);
  });

  it('never overrides the historical focused-three entry priority or its research-only pairs', () => {
    const focused = M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW;
    expect(
      orderM1DemoSixPairScan({
        phase: focused.phase,
        policyInstruments: focused.instruments,
        demoEntryInstruments: focused.demoEntryInstruments,
        decisionTime: SLOT,
      }),
    ).toEqual(['AUDUSD', 'GBPUSD', 'EURUSD', 'USDJPY', 'USDCAD', 'USDCHF']);
  });

  it('keeps SHADOW and PAPER ordering unchanged even with an arbitrary six-pair focus', () => {
    const unchanged = [...M1_TACTICAL_ROLLOUT_POLICY_V1.instruments];
    for (const phase of ['SHADOW', 'PAPER_CONTINUATION', 'PAPER_ALL_ROUTES', 'LIVE']) {
      expect(
        orderM1DemoSixPairScan({
          phase,
          policyInstruments: unchanged,
          demoEntryInstruments: undefined,
          decisionTime: SLOT,
        }),
      ).toEqual(unchanged);
    }
  });

  it('does not prioritize missing, duplicated, malformed or unvalidated six-pair lists', () => {
    const cases = [
      ['AUDUSD', 'GBPUSD', 'EURUSD', 'USDCAD', 'USDCHF'],
      ['AUDUSD', 'GBPUSD', 'EURUSD', 'USDCAD', 'USDCHF', 'XAUUSD'],
      ['AUDUSD', 'GBPUSD', 'EURUSD', 'USDCAD', 'USDCHF', 'USDCHF'],
    ];
    for (const focus of cases) {
      const order = orderM1DemoSixPairScan({
        ...input(),
        demoEntryInstruments: focus,
      });
      expect(order[0]).toBe('AUDUSD');
    }
    expect(orderM1DemoSixPairScan(input(new Date('invalid')))[0]).toBe('AUDUSD');
  });
});

describe('2026-11-12 focused two-pair DEMO M1 scanning', () => {
  const policy = M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_TWO_FEE_SHADOW;
  const params = {
    phase: policy.phase,
    policyInstruments: policy.instruments,
    demoEntryInstruments: policy.demoEntryInstruments,
    decisionTime: SLOT,
  };
  it('scans only EURUSD and AUDUSD and never calls the other four', () => {
    const scanOrder = orderM1DemoSixPairScan(params);
    expect(scanOrder).toEqual(['EURUSD', 'AUDUSD']);
    expect(scanOrder.every(pair => policy.demoEntryInstruments?.includes(pair))).toBe(true);
  });
  it('does not narrow SHADOW or PAPER scanning', () => {
    expect(orderM1DemoSixPairScan({...params, phase: 'SHADOW'})).toHaveLength(6);
    expect(orderM1DemoSixPairScan({...params, phase: 'PAPER_CONTINUATION'})).toHaveLength(6);
  });
  it('does not accidentally treat an unknown two-pair list as the operator-approved V3', () => {
    const strange = orderM1DemoSixPairScan({
      ...params,
      demoEntryInstruments: ['GBPUSD', 'USDJPY'],
    });
    expect(strange).toHaveLength(6);
  });
});
