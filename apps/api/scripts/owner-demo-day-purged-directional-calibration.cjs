'use strict';
/**
 * Pre-entry directional calibration on broker-native BID/ASK shadow outcomes.
 * No same-day future leakage: priors close BEFORE the held-out UTC day starts.
 * Identical (Plan-B route, candidate side) groups, equal-weighted market DAYS.
 * Research only. No execution, no trade veto, no side reversal authorization.
 */
const ARTIFACT='owner-demo-day-purged-direction-reliability-v1';
const HORIZON=10,ENDPOINT_BUFFER_MIN=19;
const MIN_PRIOR_DAYS=3,MIN_PRIOR_EPISODES=20,MIN_POSITIVE_DAYS=2;
const EDGE_PIPS=0.20;
const num=x=>x===null||x===undefined||x===''?null:
  Number.isFinite(Number(x))?Number(x):null;
const round=x=>x==null?null:Number(x.toFixed(4));
const utcDay=e=>typeof e?.evaluated_at==='string'?
  e.evaluated_at.slice(0,10):'';
function paired(e){
 const out=e?.outcomes?.[HORIZON]??e?.outcomes?.[String(HORIZON)];
 if(out?.status!=='PAIR_COMPARABLE')return null;
 const main=num(out.chosenNetPips),counter=num(out.reverseNetPips);
 if(main===null||counter===null)return null;
 const t=Date.parse(e.evaluated_at);
 if(!Number.isFinite(t))return null;
 return {day:utcDay(e),time:t,route:e.planb_route,side:e.direction,
   main,counter};
}
function fitPrior(prior){
 const byDay=new Map();
 for(const x of prior){
  if(!byDay.has(x.day))byDay.set(x.day,[]);
  byDay.get(x.day).push(x);
 }
 const days=[...byDay.values()].map(xs=>({
   main:xs.reduce((a,x)=>a+x.main,0)/xs.length,
   counter:xs.reduce((a,x)=>a+x.counter,0)/xs.length,
   n:xs.length,
 }));
 const samples=prior.length;
 const result={state:'INSUFFICIENT_PRIOR_INDEPENDENT_DAYS',
  preference:'NO_DIRECTION_AUTHORITY',priorDays:days.length,
  priorEpisodes:samples,meanMainNetPips:null,meanCounterNetPips:null,
  mainPositiveDays:0,counterPositiveDays:0,modifiesExecution:false};
 if(days.length<MIN_PRIOR_DAYS||samples<MIN_PRIOR_EPISODES)return result;
 const main=days.reduce((a,b)=>a+b.main,0)/days.length;
 const counter=days.reduce((a,b)=>a+b.counter,0)/days.length;
 const mainDays=days.filter(d=>d.main>0).length;
 const counterDays=days.filter(d=>d.counter>0).length;
 const mainQualified=main>EDGE_PIPS&&mainDays>=MIN_POSITIVE_DAYS&&
   main-counter>EDGE_PIPS;
 const counterQualified=counter>EDGE_PIPS&&counterDays>=MIN_POSITIVE_DAYS&&
   counter-main>EDGE_PIPS;
 return {...result,state:'HISTORICAL_AFTER_COST_DIRECTION_ASSESSMENT',
  preference:mainQualified?'MAIN_SIDE_SHADOW_PREFERRED':
    counterQualified?'COUNTER_SIDE_SHADOW_PREFERRED':
    'NO_CONSISTENT_AFTER_COST_DIRECTIONAL_EDGE',
  meanMainNetPips:round(main),meanCounterNetPips:round(counter),
  mainPositiveDays:mainDays,counterPositiveDays:counterDays};
}
function evaluateDayPurgedDirection(episodes,now=new Date()){
 if(!Array.isArray(episodes)||!Number.isFinite(now.getTime()))
  throw Error('INVALID_DIRECTIONAL_RESEARCH_INPUT');
 const prepared=episodes.map(paired).filter(Boolean)
  .sort((a,b)=>a.time-b.time);
 const evaluated=[];
 for(const sample of prepared){
  const start=Date.parse(sample.day+'T00:00:00Z');
  if(!Number.isFinite(start)||sample.time>now.getTime())continue;
  const prior=prepared.filter(x=>x.route===sample.route&&
    x.side===sample.side&&x.day<sample.day&&
    x.time+(ENDPOINT_BUFFER_MIN*60000)<start);
  const fit=fitPrior(prior);
  evaluated.push({day:sample.day,route:sample.route,side:sample.side,
   ...fit,observedMainNetPips:sample.main,
   observedCounterNetPips:sample.counter});
 }
 const ready=evaluated.filter(x=>x.state==='HISTORICAL_AFTER_COST_DIRECTION_ASSESSMENT');
 const byChoice={},byDay={};
 for(const e of ready){
  const key=e.preference;
  const b=byChoice[key]??={observations:0,actualMainNetPips:0,
    actualCounterNetPips:0,mainWinners:0,counterWinners:0,
    favorableSideHits:0};
  b.observations++;b.actualMainNetPips+=e.observedMainNetPips;
  b.actualCounterNetPips+=e.observedCounterNetPips;
  b.mainWinners+=e.observedMainNetPips>0?1:0;
  b.counterWinners+=e.observedCounterNetPips>0?1:0;
  if((key==='MAIN_SIDE_SHADOW_PREFERRED'&&e.observedMainNetPips>0)||
     (key==='COUNTER_SIDE_SHADOW_PREFERRED'&&e.observedCounterNetPips>0))
   b.favorableSideHits++;
  const z=byDay[e.day]??={comparisons:0,mainNetPips:0,counterNetPips:0};
  z.comparisons++;z.mainNetPips+=e.observedMainNetPips;
  z.counterNetPips+=e.observedCounterNetPips;
 }
 for(const b of Object.values(byChoice)){
  b.actualMainNetPips=round(b.actualMainNetPips);
  b.actualCounterNetPips=round(b.actualCounterNetPips);
 }
 for(const b of Object.values(byDay)){
  b.mainNetPips=round(b.mainNetPips);
  b.counterNetPips=round(b.counterNetPips);
 }
 return {artifact:ARTIFACT,asOf:now.toISOString(),
  horizonMinutes:HORIZON,
  mode:'RESEARCH_ONLY_NO_BROKER_AUTHORITY',
  policy:{minimumPriorIndependentUtcDays:MIN_PRIOR_DAYS,
   minimumPriorEpisodes:MIN_PRIOR_EPISODES,
   minimumPositiveIndependentDays:MIN_POSITIVE_DAYS,
   positiveEdgePips:EDGE_PIPS,
   grouping:'SAME_PLAN_B_ROUTE_AND_CANDIDATE_DIRECTION',
   priorEndpointCutoff:'STRICTLY_BEFORE_HELDOUT_UTC_DAY_START'},
  evaluated:prepared.length,qualifiedOutOfSample:ready.length,
  unavailablePrior:prepared.length-ready.length,byChoice,byDay,
  currentUtcDay:now.toISOString().slice(0,10),
  currentDayPreview:evaluated.filter(x=>x.day===now.toISOString().slice(0,10))
    .slice(-20),
  noAutoDirectionFlip:true,noNewEntryVeto:true,noLotChange:true,
  noLivePromotion:true,
  limitations:['Quote-based virtual fixed-hold marks are not broker fills.',
    'Both direction proxies may lose after commission and spread.',
    'Same-day closed outcome information never trains another forecast that day.',
    'A preference is not authorization to execute, reverse, size or suppress a trade.',
    'Minimum three distinct historical dates does not establish stable profitability.']};
}
module.exports={ARTIFACT,HORIZON,paired,fitPrior,evaluateDayPurgedDirection};
