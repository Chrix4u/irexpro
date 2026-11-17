#!/usr/bin/env node
'use strict';
/**
 * Research-only, private, exact-owner Pepperstone USD DEMO M5 dataset audit.
 * Reads preserved prospective v2 +15s bid/ask context records then matches
 * only sufficiently matured native M5 labels, without modifying any trade.
 *
 * One-shot: node scripts/run-owner-demo-m5-quote-context-readiness.cjs
 * Recurring: node scripts/run-owner-demo-m5-quote-context-readiness.cjs --watch
 */
const fs=require('node:fs'),path=require('node:path');
const {summarize,SNAP_ARTIFACT}=require('./research-owner-demo-m5-quote-context-readiness.cjs');
const SOURCE='/home/lightworld/webapps/irexpro-research/m5-context-asof';
const DEST='/home/lightworld/webapps/irexpro-research/m5-context-readiness/latest.json';
const MAX_DAY_BYTES=7*1024*1024,MAX_DAYS=45;
function readCaptures(now=new Date(),dir=SOURCE){
 const earliest=now.getTime()-MAX_DAYS*86400000,rows=[],exclusions={};
 if(!fs.existsSync(dir))return {rows,exclusions};
 for(const file of fs.readdirSync(dir).sort()){
   if(!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))continue;
   const day=Date.parse(file.slice(0,10)+'T00:00:00.000Z');
   if(day+86400000<earliest||day>now.getTime())continue;
   const full=path.join(dir,file),info=fs.statSync(full);
   if(!info.isFile()||info.size>MAX_DAY_BYTES){
     exclusions.FILE_NOT_READABLE_OR_OVER_SIZE=(exclusions.FILE_NOT_READABLE_OR_OVER_SIZE||0)+1;
     continue;
   }
   for(const line of fs.readFileSync(full,'utf8').split('\n')){
     if(!line)continue;
     try{
       const v=JSON.parse(line);
       if(v?.artifact!==SNAP_ARTIFACT)continue;
       const at=Date.parse(v.decisionAt);
       if(!Number.isFinite(at)||at<earliest||at>now.getTime()){
         exclusions.OUT_OF_WINDOW=(exclusions.OUT_OF_WINDOW||0)+1;continue;
       }
       rows.push(v);
     }catch{
       exclusions.MALFORMED_JSON=(exclusions.MALFORMED_JSON||0)+1;
     }
   }
 }
 return {rows,exclusions};
}
async function audit(now=new Date(),opts={}){
 require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
 const {Client}=require('pg');
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!owner)throw Error('EXACT_OWNER_DEMO_SCOPE_REQUIRED');
 const {rows,exclusions}=readCaptures(now,opts.sourceDir||SOURCE);
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
   database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
   ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,
   statement_timeout:15000});
 let native=[];
 try{
   await db.connect();await db.query('BEGIN READ ONLY');
   const broker=await db.query(
     "SELECT id FROM broker.broker_connections WHERE user_id=$1 AND broker_id='pepperstone-ctrader' "+
     "AND account_type='DEMO' AND account_currency='USD' AND deleted_at IS NULL "+
     "ORDER BY created_at DESC LIMIT 1",[owner]);
   if(broker.rows.length!==1)throw Error('OWNER_PEPPERSTONE_USD_DEMO_MISSING');
   if(rows.length){
     const starts=rows.map(r=>Date.parse(r.priorBarEnd)).filter(Number.isFinite);
     if(starts.length){
       const results=await db.query(
         "SELECT instrument,timeframe,source,bucket_time,created_at,updated_at, "+
         "open,high,low,close,sample_count "+
         "FROM market_data.provider_quote_candles "+
         "WHERE connection_id=$1 AND source='ctrader-broker-native' AND timeframe='M5' "+
         "AND instrument=ANY($2::text[]) AND bucket_time>=$3::timestamptz "+
         "AND bucket_time<=$4::timestamptz ORDER BY instrument,bucket_time",
         [broker.rows[0].id,['EURUSD','AUDUSD','USDJPY','USDCAD'],
          new Date(Math.min(...starts)),now]);
       native=results.rows.map(x=>({...x,
         bucket_time:new Date(x.bucket_time).toISOString(),
         created_at:new Date(x.created_at).toISOString(),
         updated_at:new Date(x.updated_at).toISOString()}));
     }
   }
   await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 const result=summarize(rows,native,now);
 result.archiveExclusions=exclusions;
 result.source='IMMUTABLE_V2_PROSPECTIVE_M5_QUOTE_CONTEXT_AND_LATER_OWNER_NATIVE_M5';
 result.ownerAccountIdExported=false;
 result.databaseReadOnly=true;
 result.nativeRecordsCompared=native.length;
 result.researchScope='EXACT_OWNER_PEPPERSTONE_CTRADER_USD_DEMO';
 result.noBrokerOrderAction=true;
 return result;
}
async function writeOnce(){
 const report=await audit();
 fs.mkdirSync(path.dirname(DEST),{recursive:true,mode:0o700});
 const temp=DEST+'.tmp.'+process.pid;
 fs.writeFileSync(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 fs.renameSync(temp,DEST);
 console.log('M5_QUOTE_TRAINING_READINESS',JSON.stringify({
   asOf:report.asOf,
   prospectiveV2:report.inputProspectiveV2Snapshots,
   matured:report.validMaturedLabels,
   pending:report.pendingOutcomeMaturation,
   distinctMaturedMarketSlots:report.distinctMaturedMarketSlots,
   distinctUtcDays:report.distinctMaturedUtcDays,
   excluded:report.excluded,
   baselineAccuracy:report.previousCandleBaselineAccuracy,
   earlyQuoteBaselineAccuracy:report.earlyCurrentQuoteBaselineAccuracy,
   byInstrument:report.perInstrument,
   trainingReady:false,promotionAllowed:false,
   source:DEST,
 }));
 return report;
}
async function main(){
 if(!process.argv.includes('--watch')){
   await writeOnce();return;
 }
 let running=false,last=0;
 const step=async()=>{
   if(running||Date.now()-last<14*60000)return;
   running=true;last=Date.now();
   try{await writeOnce();}
   catch(e){console.error('M5_READINESS_READ_ONLY_FAILURE',String(e.message).slice(0,185));}
   finally{running=false;}
 };
 await step();
 const ticker=setInterval(()=>void step(),60000);
 const stop=()=>{clearInterval(ticker);process.exit(0);};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
module.exports={SOURCE,DEST,MAX_DAYS,readCaptures,audit,writeOnce};
if(require.main===module)main().catch(e=>{
 console.error('M5_READINESS_FATAL',String(e.message).slice(0,185));
 process.exitCode=1;
});
