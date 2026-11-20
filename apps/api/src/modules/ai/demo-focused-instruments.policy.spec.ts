import {
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1,
  DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2,
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3,
  DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4,
  M1_TACTICAL_ROLLOUT_POLICY_V8_SIX_PAIR_FEE_SHADOW,
  M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_TWO_FEE_SHADOW,
  M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_FOUR_FEE_SHADOW,
  M1_TACTICAL_ROLLOUT_POLICY_V1,
  M1_TACTICAL_ROLLOUT_POLICY_V8,
  M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_COMMISSION,
  M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW,
  demoInstrumentEntryAllowed,
} from './m1-tactical-scheduler.service';
import { isCurrentFocusedDemoEntryInstrument } from './demo-focused-instruments';

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

  it('keeps all noncommission DEMO protections while cost eligibility becomes research-only', () => {
    expect(M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_COMMISSION.demoBrokerCommissionFloor).toBe(
      true,
    );
    expect(M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW).toMatchObject({
      demoBrokerCommissionFloor: false,
      demoBrokerCommissionShadow: true,
      demoPrimaryOnlyProbation: true,
      demoEntryInstruments: ['AUDUSD', 'GBPUSD', 'EURUSD'],
      paperVolumeCap: 4,
    });
    expect(
      demoInstrumentEntryAllowed(M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW, 'USDJPY'),
    ).toBe(false);
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

describe('2026-11-09 restored six-pair DEMO entry eligibility', () => {
  const restored = M1_TACTICAL_ROLLOUT_POLICY_V8_SIX_PAIR_FEE_SHADOW;

  it('versions the restored list without rewriting the focused-three policy', () => {
    expect(DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1).toEqual(['AUDUSD', 'GBPUSD', 'EURUSD']);
    expect(DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2).toEqual([
      'AUDUSD',
      'GBPUSD',
      'EURUSD',
      'USDCAD',
      'USDCHF',
      'USDJPY',
    ]);
    expect(restored.version).toBe('m1-tactical-v8-demo-primary-fee-shadow-six-pair-v2');
    expect(restored.demoEntryInstruments).toEqual(DEMO_SIX_PAIR_ENTRY_INSTRUMENTS_V2);
    expect(Object.isFrozen(restored.demoEntryInstruments)).toBe(true);
    expect(M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW.demoEntryInstruments).toEqual(
      DEMO_FOCUSED_ENTRY_INSTRUMENTS_V1,
    );
  });

  it.each(['AUDUSD', 'GBPUSD', 'EURUSD', 'USDCAD', 'USDCHF', 'USDJPY'])(
    'allows %s through the instrument gate, not around other execution gates',
    (instrument) => expect(demoInstrumentEntryAllowed(restored, instrument)).toBe(true),
  );

  it.each(['XAUUSD', 'USDJPY-ALT', 'EURUSDx', ''])(
    'keeps unapproved or suffixed instrument %s blocked',
    (instrument) => expect(demoInstrumentEntryAllowed(restored, instrument)).toBe(false),
  );

  it('retains all safety and fee-shadow settings exactly', () => {
    expect(restored).toMatchObject({
      phase: 'DEMO_EARLY_TRANSITION_PROFESSIONAL',
      demoPrimaryOnlyProbation: true,
      demoBrokerCommissionFloor: false,
      demoBrokerCommissionShadow: true,
      paperVolumeCap: 4,
    });
    expect(demoInstrumentEntryAllowed({ ...restored, demoEntryInstruments: [] }, 'USDJPY')).toBe(
      false,
    );
  });
});

describe('2026-11-12 focused two-pair DEMO execution authority', () => {
  const pilot = M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_TWO_FEE_SHADOW;
  it('uses the operator-approved two-pair allowlist without expanding risk authority', () => {
    expect(DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3).toEqual(['EURUSD', 'AUDUSD']);
    expect(Object.isFrozen(DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3)).toBe(true);
    expect(pilot.version).toBe('m1-tactical-v8-demo-primary-fee-shadow-focused2-v3');
    expect(pilot.instruments).toHaveLength(6);
    expect(pilot.demoEntryInstruments).toBe(DEMO_FOCUSED_ENTRY_INSTRUMENTS_V3);
    expect(pilot.demoPrimaryOnlyProbation).toBe(true);
    expect(pilot.demoBrokerCommissionShadow).toBe(true);
    expect(pilot.demoBrokerCommissionFloor).toBe(false);
    expect(pilot.paperVolumeCap).toBe(4);
  });
  it.each(['EURUSD', 'AUDUSD'])('allows %s to reach the ordinary independent gates', pair => {
    expect(demoInstrumentEntryAllowed(pilot, pair)).toBe(true);
  });
  it.each(['GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'EURUSDx'])('blocks DEMO entry on %s', pair => {
    expect(demoInstrumentEntryAllowed(pilot, pair)).toBe(false);
  });
});


describe('2026-11-12 owner-authorized four-pair Pepperstone DEMO eligibility', () => {
  const policy=M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_FOUR_FEE_SHADOW;
  it('allows exactly EURUSD, AUDUSD, USDCAD, USDJPY and no other symbols',()=>{
    expect(DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4).toEqual([
      'EURUSD','AUDUSD','USDCAD','USDJPY',
    ]);
    expect(Object.isFrozen(DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4)).toBe(true);
    expect(policy.demoEntryInstruments).toBe(DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4);
    expect(policy.version).toBe('m1-tactical-v8-demo-primary-fee-shadow-focused4-v4');
    expect(policy.demoEntryInstruments).toHaveLength(4);
    for(const symbol of DEMO_FOCUSED_ENTRY_INSTRUMENTS_V4) {
      expect(demoInstrumentEntryAllowed(policy,symbol)).toBe(true);
      expect(isCurrentFocusedDemoEntryInstrument(symbol)).toBe(true);
    }
    for(const symbol of ['GBPUSD','USDCHF','XAUUSD','EURUSDx','USDJPY-ALT','']) {
      expect(demoInstrumentEntryAllowed(policy,symbol)).toBe(false);
      expect(isCurrentFocusedDemoEntryInstrument(symbol)).toBe(false);
    }
  });
  it('inherits ALL original quality/risk gates and leaves historical focused-two policy immutable',()=>{
    expect(policy).toMatchObject({
      phase:'DEMO_EARLY_TRANSITION_PROFESSIONAL',
      demoPrimaryOnlyProbation:true,
      demoBrokerCommissionFloor:false,
      demoBrokerCommissionShadow:true,
      paperVolumeCap:4,
    });
    expect(policy.routeNetExpectedRFloors).toEqual(
      M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_TWO_FEE_SHADOW.routeNetExpectedRFloors,
    );
    expect(M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_TWO_FEE_SHADOW.demoEntryInstruments)
      .toEqual(['EURUSD','AUDUSD']);
    expect(demoInstrumentEntryAllowed({...policy,demoEntryInstruments:[]},'USDCAD'))
      .toBe(false);
  });
});
