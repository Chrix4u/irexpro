import { recallPepperstoneDemoPattern as recall } from './pepperstone-demo-pattern-memory';
const now=new Date('2026-11-17T10:10:00Z');
const current={score:.72,extensionAtr:.68,volatilityScore:.12,
  emaSeparation:.32,mtfStrength:.1,rsi14:43};
const sample=(minutesAgo:number,netR:number,feat=current,favorable=.12)=>({
  closedAt:new Date(now.getTime()-minutesAgo*60_000),
  features:feat,netR,maxFavorableR:favorable,maxAdverseR:-.7,
});
const params={now,route:'CONFIRMED_REVERSAL' as const,current};
describe('causal historical DEMO entry-pattern memory',()=>{
  it('detects four independently spaced repeated losing reversal patterns',()=>{
    const s=[sample(50,-1),sample(75,-.8),sample(105,-.9),
      sample(135,-.6),sample(165,.2)];
    const r=recall({...params,previous:s});
    expect(r.matchingEpisodes).toBe(5);
    expect(r.hypothesis).toBe('POSSIBLE_FALSE_REVERSAL');
    expect(r.averageNetR).toBeLessThan(-.2);
    expect(r.modifiesExecution).toBe(false);
  });
  it('never counts future outcomes or clusters same 20-minute episode as repeated proof',()=>{
    const items=[sample(-3,-1),sample(11,-1),sample(12,-1),sample(13,-1),
      sample(36,-1)];
    const r=recall({...params,previous:items});
    expect(r.matchingEpisodes).toBe(2);
    expect(r.hypothesis).toBe('INSUFFICIENT_MATCHED_HISTORY');
  });
  it('requires genuinely similar original entry features and finite history',()=>{
    const far={...current,rsi14:88,extensionAtr:3};
    const r=recall({...params,previous:[sample(60,-1,far),
      sample(95,-1),sample(125,-1)]});
    expect(r.matchingEpisodes).toBe(2);
    expect(r.hypothesis).toBe('INSUFFICIENT_MATCHED_HISTORY');
  });
  it('distinguishes profitable repeats and price peak followed by loss',()=>{
    const r=recall({...params,previous:[sample(55,.4),sample(85,.7),
      sample(115,.3),sample(145,.9),sample(180,-.2,current,.5)]});
    expect(r.hypothesis).toBe('REPEATED_FAVORABLE_PATTERN');
    expect(r.positiveThenLost).toBe(1);
  });
  it('recognizes a settled deep-adverse winner without calling the entry safe',()=>{
    const winner={
      ...sample(55,14.56/69.88120195,current,.5943),
      maxAdverseR:-64.69/69.88120195,
    };
    const r=recall({...params,route:'EARLY_TRANSITION',
      previous:[winner]});
    expect(r.matchingEpisodes).toBe(1);
    expect(r.wins).toBe(1);
    expect(r.adverseThenWon).toBe(1);
    expect(r.nearStopThenWon).toBe(1);
    expect(r.positiveThenLost).toBe(0);
    expect(r.hypothesis).toBe('INSUFFICIENT_MATCHED_HISTORY');
    expect(r.shadowOnly).toBe(true);
    expect(r.modifiesExecution).toBe(false);
  });
  it('does not label near-stop recovery for a losing or marginally adverse winner',()=>{
    const losing={...sample(50,-1),maxAdverseR:-.94};
    const shallow={...sample(80,.2),maxAdverseR:-.14};
    const medium={...sample(110,.3),maxAdverseR:-.65};
    const unknown={...sample(140,.2),maxAdverseR:null};
    const r=recall({...params,previous:[losing,shallow,medium,unknown]});
    expect(r.adverseThenWon).toBe(1);
    expect(r.nearStopThenWon).toBe(0);
    expect(r.hypothesis).toBe('MIXED_HISTORY');
  });
  it('never promotes matching patterns to trade authority',()=>{
    const r=recall({...params,route:'TREND_CONTINUATION',
      previous:[sample(55,-1),sample(85,-.9),sample(115,-.8),sample(145,-.7)]});
    expect(r.hypothesis).toBe('POSSIBLE_FALSE_CONTINUATION');
    expect(r.shadowOnly).toBe(true);
    expect(r.modifiesExecution).toBe(false);
  });
});
