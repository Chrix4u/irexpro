import {
  evaluatePepperstoneDemoContinuationPause as evaluate,
  PEPPERSTONE_DEMO_CONTINUATION_PAUSE_BLOCKER,
} from './pepperstone-demo-continuation-pause';

describe('Pepperstone DEMO trend continuation temporary pause', () => {
  const base = {
    enabled: true,
    isProfessionalDemoPhase: true,
    selectedRoute: 'TREND_CONTINUATION',
    scopedPepperstoneDemo: true,
  };
  it('vetoes new continuation authority on the exact DEMO broker', () => {
    const result = evaluate(base);
    expect(result).toMatchObject({
      blocked: true, reason: 'CONTINUATION_PAUSED',
      changesOpenPositions: false, overridesAlternativeAdmission: false,
    });
    expect(PEPPERSTONE_DEMO_CONTINUATION_PAUSE_BLOCKER).toBe(
      'M1_PEPPERSTONE_DEMO_TREND_CONTINUATION_PAUSED',
    );
  });
  it('does not bypass early-transition or reversal admission', () => {
    for(const selectedRoute of ['EARLY_TRANSITION', 'CONFIRMED_REVERSAL']){
      expect(evaluate({...base,selectedRoute})).toMatchObject({
        blocked:false,reason:'OTHER_ROUTE',overridesAlternativeAdmission:false,
      });
    }
  });
  it('leaves other brokers and non-demo phases untouched', () => {
    expect(evaluate({...base,scopedPepperstoneDemo:false}).blocked).toBe(false);
    expect(evaluate({...base,isProfessionalDemoPhase:false}).blocked).toBe(false);
    expect(evaluate({...base,enabled:false}).blocked).toBe(false);
  });
  it('fails closed on unknown broker identity while a pause is active', () => {
    expect(evaluate({...base,scopedPepperstoneDemo:null})).toMatchObject({
      blocked:true,reason:'BROKER_SCOPE_UNAVAILABLE',
    });
  });
});

describe('guarded pullback exception to continuation pause',()=>{
  it('lifts only the verified existing Pepperstone DEMO continuation pause for an admitted pullback',()=>{
    const base={ enabled:true,isProfessionalDemoPhase:true,
      selectedRoute:'TREND_CONTINUATION',scopedPepperstoneDemo:true,
      guardedPullbackRecovery:true };
    expect(evaluate(base)).toMatchObject({
      blocked:false,reason:'GUARDED_PULLBACK_RECOVERY',guardedPullbackRecovery:true
    });
    expect(evaluate({...base,guardedPullbackRecovery:false}).blocked)
      .toBe(true);
    expect(evaluate({...base,scopedPepperstoneDemo:null}).blocked)
      .toBe(true);
    expect(evaluate({...base,selectedRoute:'EARLY_TRANSITION'}).reason)
      .toBe('OTHER_ROUTE');
  });
});
