'use strict';
/**
 * Derive an aggregated RESEARCH ONLY report from append-only, prospectively
 * captured original entry, +60 second, future quote mark and settled records.
 * No trade or broker execution imports. No private trade IDs in summary.
 */
const fs=require('node:fs'),path=require('node:path');
const ROOT='/home/lightworld/webapps/irexpro-research/prospective-entry-timing';
const REPORT='latest-summary.json';
const ARTIFACT='irexpro-owner-demo-prospective-entry-outcome-summary-v1';
const SOURCE='irexpro-prospective-owner-demo-frozen-entry-timing-v1';
const ts=x=>x==null?NaN:new Date(x).getTime();
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const round=(x,k=3)=>Number(x.toFixed(k));
function groupStatus(records){
 const groups={};
 for(const r of records){
  const key=r.checkpoint?.checkpoint?.state||'NO_ON_TIME_CHECKPOINT';
  const b=groups[key]??={enrolled:0,settled:0,actualNetUsd:0,
   netWinners:0,netLosers:0,forecastPairs:0,
   submittedMeanNetR:0,actualMeanNetR:0};
  b.enrolled++;
  if(!r.settled)continue;
  const net=num(r.settled.settledNetUsd);
  if(net===null)continue;
  b.settled++;b.actualNetUsd+=net;
  if(net>0)b.netWinners++;
  if(net<0)b.netLosers++;
  const risk=num(r.entry.capitalAllocationRiskUsd);
  const predicted=num(r.entry.expectedNetR);
  if(risk!==null&&risk>0&&predicted!==null){
   b.forecastPairs++;
   b.submittedMeanNetR+=predicted;
   b.actualMeanNetR+=net/risk;
  }
 }
 for(const b of Object.values(groups)){
  b.actualNetUsd=round(b.actualNetUsd,2);
  b.submittedMeanNetR=b.forecastPairs?
   round(b.submittedMeanNetR/b.forecastPairs,4):null;
  b.actualMeanNetR=b.forecastPairs?
   round(b.actualMeanNetR/b.forecastPairs,4):null;
 }
 return groups;
}
function groupRouteAndObservedPath(records){
 // This is POST-entry explanatory evidence, never a pre-intent feature or order gate.
 const report={};
 for(const m of [1,3,5,10,20,30]){
  const groups={};
  for(const r of records){
   const mark=r.stages.get('MARK_'+m+'M');
   const o=mark?.observation;
   if(o?.status!=='SAMPLED_MARK_ONLY'||o.afterActualExit!==false||
     mark.actualTradeWasClosedBeforeMarketMark===true)continue;
   const pips=num(o.alignedPipsFromBrokerEntry);
   const net=num(r.settled?.settledNetUsd);
   if(pips===null||net===null)continue;
   const path=pips>0?'FAVORABLE':pips<0?'ADVERSE':'FLAT';
   const route=String(r.entry.route||'UNVERIFIED');
   const key=route+'|'+path;
   const group=groups[key]??={route,path,trades:0,netWinners:0,
    netLosers:0,settledNetUsd:0,averageObservedPips:0};
   group.trades++;
   if(net>0)group.netWinners++;
   if(net<0)group.netLosers++;
   group.settledNetUsd+=net;
   group.averageObservedPips+=pips;
  }
  for(const g of Object.values(groups)){
   g.settledNetUsd=round(g.settledNetUsd,2);
   g.averageObservedPips=round(g.averageObservedPips/g.trades,3);
   g.settledWinRate=round(g.netWinners/g.trades,4);
  }
  report[m+'m']=groups;
 }
 return report;
}
function summarize(events,marker,now=Date.now()){
 const ids=new Map(),errors=[];
 let ignored=0,dup=0;
 for(const e of events){
  if(!e||e.artifact!==SOURCE||!e.tradeKey||!e.stage){ignored++;continue}
  if(!ids.has(e.tradeKey))ids.set(e.tradeKey,new Map());
  const stages=ids.get(e.tradeKey);
  if(stages.has(e.stage)){dup++;continue}
  stages.set(e.stage,e);
 }
 const records=[],missed=[],rejected=[];
 for(const [tradeKey,stage] of ids){
  if(stage.has('ENTRY_MISSED'))missed.push(tradeKey);
  if(stage.has('ENTRY_REJECTED'))rejected.push(tradeKey);
  const entry=stage.get('ENTRY');if(!entry)continue;
  const entered=ts(entry.openedAt),captured=ts(entry.capturedAt);
  if(!Number.isFinite(entered)||!Number.isFinite(captured)||
    captured<entered||captured-entered>90000){
   errors.push('INVALID_ENTRY_CAPTURE_TIME');continue;
  }
  const checkpoint=stage.get('CHECKPOINT_60S')||null;
  const settled=stage.get('SETTLED')||null;
  if(checkpoint&&ts(checkpoint.capturedAt)<captured){
   errors.push('CHECKPOINT_BEFORE_ENTRY_CAPTURE');continue;
  }
  if(settled&&ts(settled.capturedAt)<captured){
   errors.push('SETTLEMENT_BEFORE_ENTRY_CAPTURE');continue;
  }
  const marks=[1,3,5,10,20,30].map(m=>stage.get('MARK_'+m+'M')||null);
  records.push({entry,checkpoint,settled,marks,stages:stage});
 }
 const byGroup=groupStatus(records);
 const byRoute={};
 for(const r of records){
  const route=String(r.entry.route||'UNVERIFIED');
  const b=byRoute[route]??={enrolled:0,settled:0,bookedNetUsd:0};
  b.enrolled++;
  if(r.settled&&num(r.settled.settledNetUsd)!==null){
   b.settled++;b.bookedNetUsd+=Number(r.settled.settledNetUsd);
  }
 }
 for(const b of Object.values(byRoute))b.bookedNetUsd=round(b.bookedNetUsd,2);
 const horizons={};
 for(const m of [1,3,5,10,20,30]){
  const observed=records.map(r=>r.stages.get('MARK_'+m+'M'))
   .filter(Boolean);
  const mark=observed.filter(x=>x.observation?.status==='SAMPLED_MARK_ONLY');
  const within=mark.filter(x=>!x.actualTradeWasClosedBeforeMarketMark&&
   x.observation?.afterActualExit===false);
  horizons[m+'m']={
   stagesObserved:observed.length,freshQuoteMarks:mark.length,
   whileOriginalPositionOpen:within.length,
   afterOriginalPositionClosedCensored:mark.length-within.length,
   favorableWhileOriginalOpen:within.filter(x=>
    (num(x.observation?.alignedPipsFromBrokerEntry)??0)>0).length,
   unfavorableWhileOriginalOpen:within.filter(x=>
    (num(x.observation?.alignedPipsFromBrokerEntry)??0)<0).length,
   cannotInferDelayedBrokerFills:true,
  };
 }
 const settled=records.filter(x=>x.settled&&num(x.settled.settledNetUsd)!==null);
 const days=new Set(records.map(x=>x.entry.openedAt.slice(0,10)));
 const settledDays=new Set(settled.map(x=>x.entry.openedAt.slice(0,10)));
 const outcome=settled.reduce((s,x)=>s+Number(x.settled.settledNetUsd),0);
 return {
  artifact:ARTIFACT,sourceArtifact:SOURCE,generatedAt:new Date(now).toISOString(),
  activationAt:marker.activatedAt,
  mode:'RESEARCH_ONLY',brokerOrders:0,modifiesExecution:false,
  modifiesLotSize:false,livePromotionAuthorized:false,
  capturedEntries:records.length,
  firstEntryMissed:missed.length,firstEntryRejected:rejected.length,
  duplicatedStageRowsIgnored:dup,
  malformedOrOtherVersionIgnored:ignored,
  corruptOrUnusableEntryRecords:errors.length,
  separatelyCapturedTradingDates:days.size,settledTradingDates:settledDays.size,
  settledTrades:settled.length,settledNetUsd:round(outcome,2),
  byOriginalEntryRoute:byRoute,byFrozen60sDecision:byGroup,
  byMarketObservationHorizon:horizons,
  byOriginalRouteAndObservedPath:groupRouteAndObservedPath(records),
  observedPathIsPostEntryOnly:true,
  observedPathCannotBeUsedAsPreEntryFeature:true,
  prospectiveQualification:'NOT_QUALIFIED',
  provisionalDataRequirement:'SEVERAL_INDEPENDENT_FUTURE_DATES_WITH_MATCHED_SETTLEMENTS',
  interpretation:[
   'A checkpoint is computed only after the original broker position is open and must have been captured within its fixed deadline.',
   'Original settled P&L belongs to the original broker trade; it is not a simulated P&L for a delayed hypothetical order.',
   'Market marks after the original trade already closed are censored from the within-trade price outcome count.',
   'Missing entry/checkpoint stages and missing quote marks are visible; they are never reconstructed from later hindsight.',
   'Future unseen independent trading dates, accurate fees, real broker stop/TP sequencing and robust drawdown testing are required before any entry or exit policy could change.',
  ],
 };
}
function readJournal(root,now=Date.now(),days=45){
 if(!Number.isFinite(now)||!Number.isInteger(days)||days>45||days<1)
  throw Error('UNBOUNDED_JOURNAL_READ');
 const events=[];
 if(!fs.existsSync(root))return {events,invalid:0};
 let invalid=0;
 const files=fs.readdirSync(root).filter(f=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  .filter(f=>ts(f.slice(0,10)+'T00:00:00Z')>=now-days*86400000)
  .sort();
 for(const f of files){
  const file=path.join(root,f),stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>12*1024*1024)
   throw Error('INVALID_OR_OVERSIZED_PROSPECTIVE_DAY');
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
   if(!line)continue;
   try{events.push(JSON.parse(line));}catch{invalid++}
   if(events.length>50000)throw Error('PROSPECTIVE_REPORT_EVENT_LIMIT');
  }
 }
 return {events,invalid};
}
function writeSummary(root,now=Date.now()){
 const marker=JSON.parse(fs.readFileSync(path.join(root,'activation.json'),'utf8'));
 if(marker.artifact!==SOURCE||!Number.isFinite(ts(marker.activatedAt)))
  throw Error('UNTRUSTED_RESEARCH_ACTIVATION');
 const {events,invalid}=readJournal(root,now);
 const report=summarize(events,marker,now);
 report.invalidJournalLines=invalid;
 const filename=path.join(root,REPORT),temp=filename+'.'+process.pid+'.tmp';
 const fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(report,null,2));}
 finally{fs.closeSync(fd)}
 fs.renameSync(temp,filename);
 return report;
}
module.exports={ROOT,REPORT,ARTIFACT,SOURCE,groupStatus,groupRouteAndObservedPath,summarize,
 readJournal,writeSummary};
if(require.main===module){
 try{
  const r=writeSummary();
  console.log('PROSPECTIVE_ENTRY_OBSERVATIONAL_SUMMARY',
   JSON.stringify({at:r.generatedAt,enrolled:r.capturedEntries,
    settled:r.settledTrades,net:r.settledNetUsd,
    dates:r.settledTradingDates,qualified:false,brokerOrders:0}));
 }catch(e){console.error('PROSPECTIVE_SUMMARY_FAILED',String(e.message).slice(0,170));
  process.exitCode=1}
}
