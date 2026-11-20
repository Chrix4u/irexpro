import {ownerDemoLossPausePolicy} from './owner-demo-loss-pauses-advisory';

const loss={
  model:{active:true,reason:'PERSISTENT_NEGATIVE_PAYOFF'},
  portfolio:{active:true,reason:'RECENT_PORTFOLIO_NET_LOSS_STREAK'},
  fastStop:{active:true,reason:'RECENT_FAST_STOP'},
};
const scope={
  featureEnabled:true,exactOwner:true,exactPepperstoneUsdDemo:true,fullAutoActive:true,
};
describe('Owner Start/Stop controls discretionary DEMO loss-history cooldowns',()=>{
  it('no automatic strategy, portfolio or rapid-stop cooldown when owner DEMO FULL_AUTO is on',()=>{
    const x=ownerDemoLossPausePolicy({...scope,...loss});
    expect(x).toMatchObject({
      advisoryOnly:true,modelLossStreakBlocks:false,
      portfolioLossStreakBlocks:false,fastStopCooldownBlocks:false,
      changesOrderDirection:false,changesPositionSizing:false,
      overridesHardRiskControls:false,
    });
    expect(x.warningCodes).toEqual([
      'MODEL_LOSS_STREAK_OBSERVED',
      'THREE_CONSECUTIVE_NET_LOSSES_OBSERVED',
      'RAPID_STOP_LOSS_OBSERVED',
    ]);
  });
  it.each([
    [{...scope,featureEnabled:false},'feature off'],
    [{...scope,exactOwner:false},'different owner'],
    [{...scope,exactPepperstoneUsdDemo:false},'different broker/live'],
    [{...scope,fullAutoActive:false},'stopped/paused AI Trader'],
  ])('keeps original enforcement outside approved owner DEMO scope: %s', (changed)=>{
    const x=ownerDemoLossPausePolicy({...changed,...loss});
    expect(x.advisoryOnly).toBe(false);
    expect(x.modelLossStreakBlocks).toBe(true);
    expect(x.portfolioLossStreakBlocks).toBe(true);
    expect(x.fastStopCooldownBlocks).toBe(true);
    expect(x.warningCodes).toEqual([]);
  });
  it('still blocks if model broker costs are unverifiable',()=>{
    const x=ownerDemoLossPausePolicy({...scope,...loss,
      model:{active:true,reason:'BROKER_COST_EVIDENCE_INCOMPLETE'}});
    expect(x.modelLossStreakBlocks).toBe(true);
    expect(x.warningCodes).not.toContain('MODEL_LOSS_STREAK_OBSERVED');
  });
  it.each(['EVIDENCE_UNAVAILABLE','COST_OR_CURRENCY_UNVERIFIED'])(
    'still blocks unresolved portfolio accounting %s',reason=>{
      const x=ownerDemoLossPausePolicy({...scope,...loss,
        portfolio:{active:true,reason}});
      expect(x.portfolioLossStreakBlocks).toBe(true);
    },
  );
  it('never creates entry permission when no actual loss warning is active',()=>{
    const x=ownerDemoLossPausePolicy({...scope,model:null,portfolio:null,fastStop:null});
    expect(x.warningCodes).toEqual([]);
    expect(x.overridesHardRiskControls).toBe(false);
  });
});
