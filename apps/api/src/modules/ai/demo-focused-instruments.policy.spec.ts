import {
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1,
  M1_TACTICAL_ROLLOUT_POLICY_V1,
  M1_TACTICAL_ROLLOUT_POLICY_V8,
  M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_COMMISSION,
  demoInstrumentEntryAllowed,
} from './m1-tactical-scheduler.service';

describe('2026-11-05 reversible DEMO focused-three entry permission', () => {
  const policy = M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_COMMISSION;

  it('keeps exactly three evidence-selected DEMO candidates while scanning all six', () => {
    expect(DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1).toEqual(['AUDUSD', 'GBPUSD', 'EURUSD']);
    expect(policy.demoEntryInstruments).toEqual(['AUDUSD', 'GBPUSD', 'EURUSD']);
    expect(policy.instruments).toEqual([
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'AUDUSD',
      'USDCAD',
      'USDCHF',
    ]);
    expect(Object.isFrozen(policy.demoEntryInstruments)).toBe(true);
    expect(policy.paperVolumeCap).toBe(4);
    expect(policy.demoPrimaryOnlyProbation).toBe(true);
    expect(policy.demoBrokerCommissionFloor).toBe(true);
  });

  it.each(['AUDUSD', 'GBPUSD', 'EURUSD'])(
    'permits %s to proceed only to the remaining risk/commission gates',
    (symbol) => {
      expect(demoInstrumentEntryAllowed(policy, symbol)).toBe(true);
    },
  );

  it.each(['USDJPY', 'USDCAD', 'USDCHF'])(
    'keeps %s research-only, unable to submit a NEW DEMO entry',
    (symbol) => {
      expect(demoInstrumentEntryAllowed(policy, symbol)).toBe(false);
    },
  );

  it('does not grant a fabricated symbol execution authority', () => {
    expect(demoInstrumentEntryAllowed(policy, 'XAUUSD')).toBe(false);
    expect(demoInstrumentEntryAllowed(policy, 'EURUSD-ALT')).toBe(false);
  });

  it('fails closed when a DEMO allowlist is explicitly empty', () => {
    expect(
      demoInstrumentEntryAllowed(
        {
          ...policy,
          demoEntryInstruments: [],
        },
        'EURUSD',
      ),
    ).toBe(false);
  });

  it('preserves older PAPER and V8 research policy semantics', () => {
    expect(demoInstrumentEntryAllowed(M1_TACTICAL_ROLLOUT_POLICY_V1, 'USDJPY')).toBe(true);
    expect(demoInstrumentEntryAllowed(M1_TACTICAL_ROLLOUT_POLICY_V8, 'USDJPY')).toBe(true);
    expect(M1_TACTICAL_ROLLOUT_POLICY_V8.demoEntryInstruments).toBeUndefined();
    expect(M1_TACTICAL_ROLLOUT_POLICY_V1.demoEntryInstruments).toBeUndefined();
  });
});
