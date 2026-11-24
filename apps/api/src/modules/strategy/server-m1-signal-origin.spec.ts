import { brandServerM1Signal, hasServerM1Origin, isStrictLiveM1PrimarySignal } from './server-m1-signal-origin';
import type { AiSignalCandidate } from './interfaces/strategy.interface';

const signal = (changes: Record<string, unknown> = {}): AiSignalCandidate =>
  ({
    userId:'owner-1',signalId:'signal-1',tradingSessionId:'session-1',
    brokerConnectionId:'connection-live-1',instrument:'EURUSD',
    direction:'BUY',confidenceScore:0.75,
    suggestedVolume:0.01,suggestedStopLoss:1.001,suggestedTakeProfit:1.009,
    timeframe:'M1',strategyCode:'external-irexpro-multimodel-ensemble',
    modelVersion:'external-provider/irexpro-multimodel-ensemble-v1/demo-v1',
    generatedAt:new Date(),
    metadata:{
      signal_source:'EXTERNAL_PROVIDER',external_provider_paper_only:true,
      multimodel_plan_b_route:'CONFIRMED_REVERSAL',
      multimodel_plan_b_paper_admitted:true,
      multimodel_execution_authority_path:'PRIMARY_PLAN_B',
      m1_tactical_route:'M1_CONFIRMED_REVERSAL',
      m1_professional_fallback:false,m5_early_transition_handoff:false,
      m1_pepperstone_demo_alternative_trial:false,
      extension_exhaustion_demo_scout:false,
    },
    ...changes,
  }) as AiSignalCandidate;

describe('SERVER-owned Pepperstone LIVE M1 primary provenance',()=>{
  it('rejects any externally provided JSON candidate even when all fields look valid',()=>{
    const fromJson=JSON.parse(JSON.stringify(signal())) as AiSignalCandidate;
    expect(hasServerM1Origin(fromJson)).toBe(false);
    expect(isStrictLiveM1PrimarySignal(fromJson)).toBe(false);
    expect(isStrictLiveM1PrimarySignal(signal())).toBe(false);
  });
  it('brands only an in-process object, never serializable provenance',()=>{
    const original=signal();
    brandServerM1Signal(original);
    expect(hasServerM1Origin(original)).toBe(true);
    expect(isStrictLiveM1PrimarySignal(original)).toBe(true);
    expect(isStrictLiveM1PrimarySignal(JSON.parse(JSON.stringify(original)))).toBe(false);
    expect(Object.getOwnPropertySymbols(original)).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(original,Object.getOwnPropertySymbols(original)[0]!)?.writable).toBe(false);
  });
  it('rejects a mismatched Early Transition M1 route for Plan-B Confirmed Reversal',()=>{
    const candidate=signal({
      metadata:{...signal().metadata,m1_tactical_route:'M1_EARLY_TRANSITION'},
    });
    brandServerM1Signal(candidate);
    expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
  });
  it('rejects a demo alternate even when the primary tuple and M1 route match',()=>{
    const candidate=signal({
      metadata:{...signal().metadata,m1_pepperstone_demo_alternative_trial:true},
    });
    brandServerM1Signal(candidate);
    expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
  });
  it('rejects disabled Plan-B, nonprimary research paths and changed model identities',()=>{
    const variants=[
      {metadata:{...signal().metadata,multimodel_plan_b_paper_admitted:false}},
      {metadata:{...signal().metadata,multimodel_execution_authority_path:'BLOCKED'}},
      {metadata:{...signal().metadata,m5_early_transition_handoff:true}},
      {metadata:{...signal().metadata,m1_professional_fallback:true}},
      {metadata:{...signal().metadata,extension_exhaustion_demo_scout:true}},
      {strategyCode:'external-caller-pretending-to-be-m1'},
    ];
    for(const fields of variants){
      const candidate=brandServerM1Signal(signal(fields));
      expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
    }
  });
});
