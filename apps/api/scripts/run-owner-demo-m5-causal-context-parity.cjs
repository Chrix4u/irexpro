#!/usr/bin/env node
'use strict';
const {readBoundedText}=require('./bounded-research-file.cjs');
/**
 * Owner Pepperstone USD DEMO read-only historical M5 parity report.
 * NEVER imports any broker execution module. No order routing.
 * Native M5 comparison is RETROSPECTIVE; as-of quote evidence is verified
 * independently by original source/observed timestamps, never by OHLC hindsight.
 */
const fs=require('node:fs'),path=require('node:path');
const {validQuote}=require('./collect-owner-demo-forming-candle-snapshots.cjs');
const {
 ARTIFACT,WIDTH,INSTRUMENTS,nativeM1Rollup,quoteM5AsOf,
 nativeM5Outcome,comparison,aggregate,
}=require('./research-owner-demo-m5-causal-context-parity.cjs');
const SOURCE='/home/lightworld/webapps/irexpro-research/native-quote-snapshots';
const OUT='/home/lightworld/webapps/irexpro-research/m5-context-parity/latest.json';
const MAX_FILE_BYTES=32*1024*1024;
const HOURS=12;
function quoteIndex(from,to,sourceDir=SOURCE){
 const index=new Map();let scanned=0,rejected=0;
 const days=new Set();
 for(let d=new Date(from);d<=to;d=new Date(d.getTime()+86400000))
   days.add(d.toISOString().slice(0,10));
 days.add(to.toISOString().slice(0,10));
 for(const day of days){
   const f=path.join(sourceDir,day+'.jsonl');
   const body=readBoundedText(f,MAX_FILE_BYTES,'SOURCE_QUOTE_ARCHIVE_FILE_EXCEEDS_BOUND',true);
   if(body===null)continue;
   for(const line of body.split('\n')){
     if(!line)continue;
     let raw;
     try{raw=JSON.parse(line);}catch{rejected++;continue;}
     const q=validQuote(raw);
     if(!q||q.source<from.getTime()||q.source>=to.getTime()){rejected++;continue;}
     const bucket=Math.floor(q.source/WIDTH)*WIDTH;
     const k=q.instrument+'|'+bucket;
     (index.get(k)||index.set(k,[]).get(k)).push(q);
     scanned++;
   }
 }
 return {index,scanned,rejected,days:[...days]};
}
async function study(opts={}){
 require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
 const {Client}=require('pg');
 const now=opts.now||new Date();
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!owner)throw Error('EXACT_OWNER_ID_REQUIRED');
 const since=new Date(now.getTime()-(opts.hours||HOURS)*3600000);
 // Fetch only M5 intervals whose end was at least 90 seconds ago.
 const latest=new Date(now.getTime()-WIDTH-90000);
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
   database:process.env.DB_NAME,user:process.env.DB_USER,
   password:process.env.DB_PASSWORD,
   ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
   statement_timeout:25000});
 let allRows=[],connectionId=null;
 try{
   await db.connect();await db.query('BEGIN READ ONLY');
   const broker=await db.query(
     "SELECT id FROM broker.broker_connections WHERE user_id=$1 "+
     "AND broker_id='pepperstone-ctrader' AND account_type='DEMO' "+
     "AND account_currency='USD' AND deleted_at IS NULL "+
     "ORDER BY created_at DESC LIMIT 1",[owner]);
   if(broker.rows.length!==1)throw Error('OWNER_DEMO_BROKER_REQUIRED');
   connectionId=broker.rows[0].id;
   const r=await db.query(
     "SELECT instrument,timeframe,bucket_time,open,high,low,close,"+
     "sample_count,positive_quote_sample_count,last_quote_sample_at,"+
     "source,created_at,updated_at FROM market_data.provider_quote_candles "+
     "WHERE connection_id=$1 AND instrument=ANY($2::text[]) "+
     "AND timeframe IN ('M1','M5') AND source='ctrader-broker-native' "+
     "AND bucket_time >= $3 AND bucket_time <= $4 "+
     "ORDER BY instrument,timeframe,bucket_time",
     [connectionId,INSTRUMENTS,since,latest]);
   allRows=r.rows;
   await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 const quoteData=quoteIndex(since,now,opts.sourceDir||SOURCE);
 const byPair=new Map();for(const instrument of INSTRUMENTS)
   byPair.set(instrument,{m1:new Map(),m5:[]});
 for(const row of allRows){
   const v=byPair.get(row.instrument);if(!v)continue;
   if(row.timeframe==='M1')v.m1.set(new Date(row.bucket_time).getTime(),row);
   if(row.timeframe==='M5')v.m5.push(row);
 }
 const comparisons=[],coverage={};
 for(const inst of INSTRUMENTS){
   const rows=[];
   const data=byPair.get(inst);
   for(const nativeRow of data.m5){
     const start=new Date(nativeRow.bucket_time).getTime();
     if(start%WIDTH)continue;const cutoff=start+WIDTH+15000;
     if(cutoff>now.getTime())continue;
     const native=nativeM5Outcome(nativeRow,start);
     if(!native)continue;
     const relevant=Array.from({length:5},(_,i)=>data.m1.get(start+i*60000)).filter(Boolean);
     const m1=nativeM1Rollup(relevant,start,cutoff);
     const quote=quoteM5AsOf(quoteData.index.get(inst+'|'+start)||[],inst,start,cutoff);
     const r={
       instrument:inst,barStart:new Date(start).toISOString(),
       decisionAt:new Date(cutoff).toISOString(),
       nativeCreatedByNext15s: native.nativeM5CreatedAt!==null &&
          native.nativeM5CreatedAt<=cutoff,
       nativeDelaySeconds:native.nativeM5CreatedAt===null?null:
          Math.round((native.nativeM5CreatedAt-start-WIDTH)/1000),
       m1,quote,
       m1Comparison:comparison(native,m1,inst),
       quoteComparison:comparison(native,quote,inst),
     };
     rows.push(r);comparisons.push(r);
   }
   coverage[inst]=aggregate(rows);
 }
 const full=aggregate(comparisons);
 return {
   artifact:ARTIFACT,generatedAt:now.toISOString(),researchOnly:true,
   modifiesExecution:false,promotionAllowed:false,
   exactOwnerPepperstoneUsdDemo:true,statementMode:'BEGIN READ ONLY',
   brokerOrderAuthority:false,modelFilesModified:false,
   lookbackHours:opts.hours||HOURS,
   nativeDatabaseRowsScanned:allRows.length,
   archivedQuotesScanned:quoteData.scanned,
   archivedQuotesRejectedOrOutOfWindow:quoteData.rejected,
   archiveDays:quoteData.days,
   findings:full,byInstrument:coverage,
   samples:comparisons.slice(-8).map(x=>({
     instrument:x.instrument,barStart:x.barStart,
     decisionAt:x.decisionAt,nativeDelaySeconds:x.nativeDelaySeconds,
     nativeCreatedByNext15s:x.nativeCreatedByNext15s,
     m1Status:x.m1.status,dbM1UnrevisedByCutoff:x.m1.lastM1UpdateByCutoff,
     quoteStatus:x.quote.status,m1Comparison:x.m1Comparison,
     quoteComparison:x.quoteComparison,
   })),
   caveats:[
     'Even exact retrospective M1/M5 OHLC parity does not prove mutable database M1 bars were finalized at the intended decision timestamp.',
     'Append-only positive bid-ask source/observed timestamps provide a stronger as-of check. Sampled midquotes can differ from native M5 trend-bar OHLC.',
     'M5 model was trained on native M5 OHLC; quote-sampled substituted M5 features are NOT proven distribution-equivalent.',
     'No M5 earlier-stage forward predictions are newly authorized. The running scorer continues to fail closed when its native preceding bar is unavailable.',
     'This read-only parity report does not certify after-fee profit, next-candle forecasting edge, risk-at-stop, or broker fill prices.',
   ],
 };
}
async function main(){
 const report=await study();
 const output=process.argv.find(x=>x.startsWith('--out='))?.slice(6)||OUT;
 if(path.resolve(output)!==path.resolve(OUT)&&!path.resolve(output).startsWith('/tmp/'))
   throw Error('PRIVATE_OUTPUT_PATH_REQUIRED');
 fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
 const tmp=output+'.tmp-'+process.pid;
 fs.writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 fs.renameSync(tmp,output);
 console.log(JSON.stringify({artifact:report.artifact,at:report.generatedAt,
   nativeDatabaseRowsScanned:report.nativeDatabaseRowsScanned,
   archivedQuotesScanned:report.archivedQuotesScanned,findings:report.findings,
   byInstrument:report.byInstrument,output,executionUnchanged:true},null,2));
}
module.exports={study,quoteIndex};
if(require.main===module)main().catch(e=>{
 console.error('READ_ONLY_M5_CONTEXT_PARITY_ABORTED',String(e.message).slice(0,280));
 process.exitCode=1;
});
