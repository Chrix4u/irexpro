#!/usr/bin/env node
'use strict';
const {readBoundedText}=require('./bounded-research-file.cjs');
/**
 * Read-only owner's Pepperstone USD DEMO trade-window analysis.
 * "Hit TP first" is a SAMPLED path label, never a real broker fill proof.
 * Compare original intent TP/SL vs first recorded barrier after early close.
 */
const fs=require('node:fs'),path=require('node:path');
const {validQuote}=require('./audit-owner-demo-drawdown-guard-postexit.cjs');
const START='2026-11-20T04:30:00.000Z';
const OUT='/home/lightworld/webapps/irexpro-research/exit-payoff/latest-nov20-from-0430-tp-first.json';
const SQL=[
 'SELECT t.id::text trade_id,t.opened_at,t.closed_at,t.status,',
 't.instrument,t.direction,t.lot_size,t.fill_price,t.exit_price,t.close_reason,',
 't.realised_pnl,t.commission,t.swap,',
 'ti.stop_loss AS original_stop,ti.take_profit AS original_target,',
 't.stop_loss AS last_recorded_stop,t.take_profit AS last_recorded_target,',
 "ti.metadata->>'multimodel_plan_b_route' AS route",
 'FROM trading.trades t JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id AND ti.user_id=t.user_id',
 'AND ti.broker_connection_id=t.broker_connection_id',
 'WHERE t.user_id=$1 AND b.user_id=$1',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND t.account_currency='USD' AND b.deleted_at IS NULL",
 'AND t.opened_at>=$2::timestamptz AND t.opened_at<=$3::timestamptz',
 'ORDER BY t.opened_at,t.id LIMIT 301'
].join(' ');
const ms=x=>x==null?NaN:new Date(x).getTime();
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const rnd=(x,p=3)=>Number(x.toFixed(p));
function touch(q,t,target,stop){
 const closeSide=t.direction==='BUY'?q.bid:q.ask;
 const tp=t.direction==='BUY'?closeSide>=target-1e-9:closeSide<=target+1e-9;
 const sl=t.direction==='BUY'?closeSide<=stop+1e-9:closeSide>=stop-1e-9;
 return {tp,sl,closeSide};
}
function loadQuotes(filename,until=Date.now()){
 const byPair=new Map(),stats={parsed:0,rejected:0,accepted:0};
 const body=readBoundedText(filename,30*1024*1024,'QUOTE_ARCHIVE_OVER_LIMIT',true);
 if(body===null)throw Error('QUOTE_ARCHIVE_MISSING');
 const all=body.split('\n');
 for(const line of all){if(!line)continue;stats.parsed++;
  let raw;try{raw=JSON.parse(line)}catch{stats.rejected++;continue}
  const q=validQuote(raw);
  if(!q||q.source>until||q.captured>until){stats.rejected++;continue}
  (byPair.get(q.instrument)||byPair.set(q.instrument,[]).get(q.instrument)).push(q);
  stats.accepted++;
 }
 for(const arr of byPair.values())arr.sort((a,b)=>a.source-b.source||a.captured-b.captured);
 return {byPair,stats};
}
function pathSegment(trade,quotes,start,end,stop,target){
 const points=quotes.filter(x=>x.source>=start&&x.source<=end&&x.captured<=end);
 const res={samples:points.length,
  firstTouch:'NONE',firstTargetAt:null,firstStopAt:null,
  firstTargetQuoteSide:null,firstStopQuoteSide:null,
  firstQuoteAt:points.length?new Date(points[0].source).toISOString():null,
  lastQuoteAt:points.length?new Date(points.at(-1).source).toISOString():null,
  maxGapSeconds:null,firstGapSeconds:null,lastGapSeconds:null,
  pathCoverage:'INSUFFICIENT',firstTouchProvesExecution:false};
 if(!points.length||end<=start)return res;
 let maxGap=0;
 for(let i=1;i<points.length;i++)maxGap=Math.max(maxGap,points[i].source-points[i-1].source);
 const fg=points[0].source-start,lg=end-points.at(-1).source;
 res.maxGapSeconds=rnd(maxGap/1000);
 res.firstGapSeconds=rnd(fg/1000);
 res.lastGapSeconds=rnd(lg/1000);
 res.pathCoverage=points.length>=2&&fg<=30000&&lg<=30000&&maxGap<=60000?
  'CONTIGUOUS_SAMPLED_PATH':'INCOMPLETE_SAMPLED_PATH';
 for(const q of points){
  const hit=touch(q,trade,target,stop);
  if(hit.tp&&res.firstTargetAt===null){res.firstTargetAt=new Date(q.source).toISOString();res.firstTargetQuoteSide=hit.closeSide;}
  if(hit.sl&&res.firstStopAt===null){res.firstStopAt=new Date(q.source).toISOString();res.firstStopQuoteSide=hit.closeSide;}
  if(res.firstTouch==='NONE'&&(hit.tp||hit.sl))res.firstTouch=
   hit.tp&&hit.sl?'BOTH_SAME_SAMPLE':hit.tp?'TP_FIRST_SAMPLED':'SL_FIRST_SAMPLED';
 }
 return res;
}
function classify(t,quotes,now){
 const opened=ms(t.opened_at),closed=ms(t.closed_at);
 const settled=t.status==='CLOSED'&&Number.isFinite(closed)&&closed<=now;
 const target=num(t.original_target),stop=num(t.original_stop),
  laterTarget=num(t.last_recorded_target),laterStop=num(t.last_recorded_stop);
 if(!['BUY','SELL'].includes(t.direction)||!target||!stop||!Number.isFinite(opened)||opened>now)throw Error('TRADE_INVALID');
 const first=pathSegment(t,quotes,opened,settled?closed:now,stop,target);
 const post=settled?pathSegment(t,quotes,closed,now,stop,target):null;
 const lastSet=settled&&laterTarget&&laterStop?
  pathSegment(t,quotes,closed,now,laterStop,laterTarget):null;
 const pnl=[num(t.realised_pnl),num(t.commission),num(t.swap)];
 const net=settled&&pnl.every(x=>x!==null)?rnd(pnl.reduce((s,x)=>s+x,0),2):null;
 return {tradeId:t.trade_id,
  instrument:t.instrument,direction:t.direction,
  route:t.route||'UNKNOWN',
  openedAt:new Date(opened).toISOString(),
  closedAt:settled?new Date(closed).toISOString():null,
  closeReason:settled?t.close_reason:null,
  status:t.status,filledLots:num(t.lot_size),
  entryPrice:num(t.fill_price),exitPrice:num(t.exit_price),
  originalTp:target,originalSl:stop,
  lastRecordedTp:laterTarget,lastRecordedSl:laterStop,
  netUsdSettled:net,
  beforeCloseOrNow:first,
  afterCloseOriginalBarriers:post,
  afterCloseLastRecordedBarriers:lastSet,
  postCloseOriginalTpBeforeOriginalSl:
    post?.pathCoverage==='CONTIGUOUS_SAMPLED_PATH'&&post.firstTouch==='TP_FIRST_SAMPLED',
  postCloseOriginalSlBeforeOriginalTp:
    post?.pathCoverage==='CONTIGUOUS_SAMPLED_PATH'&&post.firstTouch==='SL_FIRST_SAMPLED',
  cannotProveHypotheticalFill:true};
}
function aggregate(trades,now){
 const closed=trades.filter(x=>x.status==='CLOSED');
 const profit=closed.filter(x=>x.closeReason==='PROFIT_PROTECTION');
 const summary=rows=>({
  count:rows.length,
  firstTpBeforeClose:rows.filter(x=>x.beforeCloseOrNow.firstTouch==='TP_FIRST_SAMPLED'&&
    x.beforeCloseOrNow.pathCoverage==='CONTIGUOUS_SAMPLED_PATH').length,
  firstSlBeforeClose:rows.filter(x=>x.beforeCloseOrNow.firstTouch==='SL_FIRST_SAMPLED'&&
    x.beforeCloseOrNow.pathCoverage==='CONTIGUOUS_SAMPLED_PATH').length,
  firstTpAfterClose:rows.filter(x=>x.postCloseOriginalTpBeforeOriginalSl).length,
  firstSlAfterClose:rows.filter(x=>x.postCloseOriginalSlBeforeOriginalTp).length,
  neitherAfterClose:rows.filter(x=>x.afterCloseOriginalBarriers?.firstTouch==='NONE'&&
    x.afterCloseOriginalBarriers?.pathCoverage==='CONTIGUOUS_SAMPLED_PATH').length,
  incompletePostClosePath:rows.filter(x=>x.afterCloseOriginalBarriers?.pathCoverage!=='CONTIGUOUS_SAMPLED_PATH').length,
  netUsdSettled:rnd(rows.reduce((s,t)=>s+(t.netUsdSettled||0),0),2)});
 return {
  artifact:'irexpro-owner-pepperstone-usd-demo-20261120-0430-tp-first-readonly-v1',
  asOf:new Date(now).toISOString(),from:START,
  quoteSource:'Two-clock validated broker-native bid/ask sampled archive (not broker execution history)',
  positions:trades.length,closed:closed.length,
  closedWins:closed.filter(x=>x.netUsdSettled>0).length,
  closedLosses:closed.filter(x=>x.netUsdSettled<0).length,
  allClosed:summary(closed),
  profitProtection:summary(profit),
  byCloseReason:Object.fromEntries([...new Set(closed.map(x=>x.closeReason))].map(reason=>[
   reason,summary(closed.filter(x=>x.closeReason===reason))])),
  byInstrument:Object.fromEntries([...new Set(trades.map(x=>x.instrument))].map(sym=>[
   sym,summary(closed.filter(x=>x.instrument===sym))])),
  trades,
  limitations:[
   'TP_FIRST_SAMPLED means first observed bid or ask at or beyond the original intent TP, not a verified broker TP fill.',
   'Broker may have modified TP/SL after entry. Both ORIGINAL intent barriers and last recorded modified barriers are analyzed separately.',
   'After-close observation uses quotes after the actual close. It is a hypothetical held position with no proven broker outcome.',
   'For BUY we compare BID; for SELL ASK. Missing source/capture timestamps or quote lag >15s are excluded.',
   'Incomplete quote segments have NOT been considered proof of the first target or stop; 30-second boundary and 60-second adjacent gaps used.',
   'Even continuous sampled quotes can miss intrabar SL/TP crossings and execution slippage. Broker order/deal history is needed for definitive first-hit labels.',
   'A sampled future target does not prove holding through all stop amendments, fees, profit-locks, margin pressure or alternative executions would have been feasible.',
   'No order, lot-size permission, stop, target, profit protection, or live trading setting is changed by this audit.',
  ],
  noSqlWrites:true,researchOnly:true,brokerOrders:false,
 };
}
async function run(now=new Date()){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!/^[0-9a-f-]{36}$/i.test(owner||''))throw Error('OWNER_NOT_CONFIGURED');
 const {Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  application_name:'irexpro-owner-TP-first-window-READONLY',statement_timeout:16000});
 let rows;await db.connect();
 try{await db.query('BEGIN READ ONLY');
  rows=(await db.query(SQL,[owner,START,now.toISOString()])).rows;
  await db.query('ROLLBACK');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 if(rows.length>300)throw Error('TRADES_EXCEED_REPORT_LIMIT');
 const quotes=loadQuotes('/home/lightworld/webapps/irexpro-research/native-quote-snapshots/2026-11-20.jsonl',now.getTime());
 const trades=rows.map(r=>classify(r,quotes.byPair.get(r.instrument)||[],now.getTime()));
 const report={...aggregate(trades,now.getTime()),sourceQuoteStats:quotes.stats};
 fs.mkdirSync(path.dirname(OUT),{recursive:true,mode:0o700});
 fs.writeFileSync(OUT,JSON.stringify(report,null,2),{mode:0o600});
 console.log('OWNER_TP_FIRST_WINDOW '+JSON.stringify({
  asOf:report.asOf,trades:report.positions,closed:report.closed,
  profitProtection:report.profitProtection,allClosed:report.allClosed,noOrders:true,
 }));
 return report;
}
module.exports={START,SQL,touch,pathSegment,classify,aggregate,run};
if(require.main===module)run().catch(e=>{
 console.error('OWNER_TP_FIRST_WINDOW_FAILED',String(e.message).slice(0,200));process.exitCode=1
});
