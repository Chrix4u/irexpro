/**
 * Causal, owner-scoped DEMO analogue memory.
 * Similarity recall is RESEARCH only: a matched losing case is a hypothesis,
 * never permission to place an opposite-direction broker order.
 */
export const PEPPERSTONE_PATTERN_MEMORY_ARTIFACT =
  'pepperstone-demo-causal-pattern-memory-v1' as const;

export interface EntryPattern {
  score:number;extensionAtr:number;volatilityScore:number;
  emaSeparation:number;mtfStrength:number;rsi14:number;
}
export interface SettledPatternExample {
  closedAt:Date|string;
  features:EntryPattern;
  netR:number;
  maxFavorableR:number|null;
  maxAdverseR:number|null;
}
export interface PatternMemoryObservation {
  artifact:typeof PEPPERSTONE_PATTERN_MEMORY_ARTIFACT;
  shadowOnly:true;
  matchingEpisodes:number;
  comparedClosedTrades:number;
  wins:number;losses:number;
  averageNetR:number|null;
  positiveThenLost:number;
  nearestDistance:number|null;
  hypothesis:'INSUFFICIENT_MATCHED_HISTORY'|'POSSIBLE_FALSE_REVERSAL'|
    'POSSIBLE_FALSE_CONTINUATION'|'REPEATED_FAVORABLE_PATTERN'|'MIXED_HISTORY';
  modifiesExecution:false;
}
const FIELDS:[keyof EntryPattern,number][]=[
  ['score',0.25],['extensionAtr',0.85],['volatilityScore',0.28],
  ['emaSeparation',0.40],['mtfStrength',0.38],['rsi14',16],
];
function distance(a:EntryPattern,b:EntryPattern):number|null {
  let total=0;
  for(const [key,scale] of FIELDS){
    if(typeof a[key]!=='number'||typeof b[key]!=='number'||
      !Number.isFinite(a[key])||!Number.isFinite(b[key]))return null;
    total+=Math.min(1,Math.abs(a[key]-b[key])/scale);
  }
  return total/FIELDS.length;
}
export function recallPepperstoneDemoPattern(input:{
  now:Date;route:'CONFIRMED_REVERSAL'|'EARLY_TRANSITION'|'TREND_CONTINUATION';
  current:EntryPattern;previous:readonly SettledPatternExample[];
}):PatternMemoryObservation {
  const observed=input.now.getTime();
  const candidates=input.previous
    .map(s=>({...s,at:new Date(s.closedAt).getTime(),distance:distance(input.current,s.features)}))
    .filter(s=>Number.isFinite(s.at)&&s.at<observed&&s.at>=observed-90*24*3600_000&&
      s.distance!==null&&s.distance<=0.24&&Number.isFinite(s.netR))
    .sort((a,b)=>a.distance!-b.distance!);
  // Correlated minute-by-minute re-entries are one market episode, not
  // multiple statistically independent validations of the same hypothesis.
  const unique=new Set<number>();
  const matches= candidates.filter(s=>{
    const episode=Math.floor(s.at/(20*60_000));
    if(unique.has(episode))return false;
    unique.add(episode);return true;
  }).slice(0,12);
  const wins=matches.filter(s=>s.netR>0).length;
  const losses=matches.filter(s=>s.netR<0).length;
  const average=matches.length?matches.reduce((a,b)=>a+b.netR,0)/matches.length:null;
  const positiveThenLost=matches.filter(s=>s.netR<0&&
    typeof s.maxFavorableR==='number'&&s.maxFavorableR>=0.2).length;
  let hypothesis:PatternMemoryObservation['hypothesis']='INSUFFICIENT_MATCHED_HISTORY';
  if(matches.length>=4){
    if(losses/matches.length>=0.75&&(average??0)<-0.2){
      hypothesis=input.route==='TREND_CONTINUATION'
        ? 'POSSIBLE_FALSE_CONTINUATION':'POSSIBLE_FALSE_REVERSAL';
    }else if(wins/matches.length>=0.7&&(average??0)>0.1)
      hypothesis='REPEATED_FAVORABLE_PATTERN';
    else hypothesis='MIXED_HISTORY';
  }
  return {
    artifact:PEPPERSTONE_PATTERN_MEMORY_ARTIFACT,
    shadowOnly:true,modifiesExecution:false,
    matchingEpisodes:matches.length,comparedClosedTrades:input.previous.length,
    wins,losses,averageNetR:average,
    positiveThenLost,nearestDistance:matches[0]?.distance??null,hypothesis,
  };
}
