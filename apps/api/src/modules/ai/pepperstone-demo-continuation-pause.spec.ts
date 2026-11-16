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
