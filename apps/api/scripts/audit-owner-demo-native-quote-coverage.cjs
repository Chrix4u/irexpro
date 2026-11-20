#!/usr/bin/env node
'use strict';
// Read-only freshness/coverage summary of the existing broker-native quote archive.
const fs=require('node:fs'),path=require('node:path');
const SOURCE='/home/lightworld/webapps/irexpro-research/native-quote-snapshots/2026-11-20.jsonl';
const OUT='/home/lightworld/webapps/irexpro-research/native-quote-snapshots/latest-coverage-report.json';
const BEGIN='2026-11-20T04:30:00.000Z';
const PAIRS=['EURUSD','GBPUSD','AUDUSD','USDJPY','USDCAD','USDCHF'];
function parse(line,asOf){
  let x;try{x=JSON.parse(line)}catch{return null}
  if(!Array.isArray(x)||x.length!==5||!PAIRS.includes(x[2]))return null;
  const source=Date.parse(x[0]),captured=Date.parse(x[1]),now=Date.parse(asOf);
  if(!Number.isFinite(source)||!Number.isFinite(captured)||!Number.isFinite(now)||
    source<Date.parse(BEGIN)||source>now||captured<source||captured>now||
    captured-source>15000||!(x[3]>0)||!(x[4]>x[3]))return null;
  return {symbol:x[2],source,captured,bid:x[3],ask:x[4]};
}
function summarize(lines,asOf){
  const stamps=Object.fromEntries(PAIRS.map(p=>[p,new Set()]));
  let seen=0,rejected=0;
  for(const line of lines){
    if(!line)continue;seen++;
    const q=parse(line,asOf);
    if(!q){rejected++;continue}
    stamps[q.symbol].add(q.source);
  }
  const pairs=Object.fromEntries(PAIRS.map(p=>{
    const xs=[...stamps[p]].sort((a,b)=>a-b);
    const gaps=xs.slice(1).map((v,i)=>(v-xs[i])/1000).sort((a,b)=>a-b);
    const pick=f=>gaps.length?Math.round(gaps[Math.min(gaps.length-1,Math.floor((gaps.length-1)*f))]*1000)/1000:null;
    const max=gaps.length?gaps.at(-1):null;
    return [p,{samples:xs.length,firstSample:xs.length?new Date(xs[0]).toISOString():null,
      lastSample:xs.length?new Date(xs.at(-1)).toISOString():null,
      medianGapSeconds:pick(0.5),p95GapSeconds:pick(0.95),
      maxGapSeconds:max,sourceGapsOver60Seconds:gaps.filter(n=>n>60).length,
      coverageFlag:xs.length<2?'INSUFFICIENT_SAMPLES':max>60?'GAPS_OVER_60_SECONDS':'NO_GAP_OVER_60_SECONDS'}];
  }));
  return {artifact:'owner-demo-native-quote-coverage-readonly-v1',from:BEGIN,asOf,
    source:'validated pre-existing Pepperstone broker-native sampled quote archive',
    rawLines:seen,rejected,pairs,ordersSent:0,sqlWrites:0,executionChanged:false,
    limitations:['Gaps are in recorded quote samples, not proof of broker stream outage.',
      'Bid/ask stream is event-driven; sample density differs with market activity.',
      'An archive missing a quote cannot prove price did not hit a TP or SL.',
      'No user positions, broker settings, lot sizes or exit decisions are changed.']};
}
function run(asOf=new Date().toISOString()){
  const stat=fs.statSync(SOURCE);
  if(stat.size>36*1024*1024)throw Error('DAY_ARCHIVE_TOO_LARGE');
  const r=summarize(fs.readFileSync(SOURCE,'utf8').split('\n'),asOf);
  fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
  fs.writeFileSync(OUT,JSON.stringify(r,null,2),{mode:0o600});
  console.log('OWNER_DEMO_NATIVE_QUOTE_COVERAGE '+JSON.stringify({
    asOf:r.asOf,pairs:r.pairs,ordersSent:0,sqlWrites:0}));
  return r;
}
module.exports={BEGIN,PAIRS,parse,summarize,run};
if(require.main===module)run();
