'use strict';
/**
 * Owner-scoped, READ-ONLY post-exit attribution on broker-native M1 bid/ask
 * *closing marks*. A sampled bar-close not touching TP cannot exclude an
 * intrabar TP hit. This is not a future claim or executable exit policy.
 */
const {resolve}=require('node:path');
const {mkdirSync,openSync,writeFileSync,renameSync,closeSync}=require('node:fs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HORIZONS=[3,5,10,15];
const OUT='/home/lightworld/webapps/irexpro-research/profit-lock-postexit/latest-report.json';
const SQL=`
SELECT t.id::text trade_key,t.instrument,t.direction,t.closed_at,
 t.fill_price AS entry_price,t.exit_price,t.stop_loss,t.take_profit,t.realised_pnl,t.commission,t.swap,
 ti.metadata->>'multimodel_plan_b_route' strategy_route,
 q.bucket_time,q.open,q.high,q.low,q.close,
 q.bid_close,q.ask_close,q.sample_count,q.positive_quote_sample_count,
 q.last_positive_sample_at,q.source
FROM trading.trades t
JOIN broker.broker_connections b ON b.id=t.broker_connection_id
LEFT JOIN trading.trade_intents ti ON ti.id=t.trade_intent_id
LEFT JOIN market_data.provider_quote_candles q
 ON q.connection_id=t.broker_connection_id
 AND q.instrument=t.instrument AND q.timeframe='M1'
 AND q.source='ctrader-broker-native'
 AND q.bucket_time>=date_trunc('minute',t.closed_at)
 AND q.bucket_time<t.closed_at + interval '15 minutes'
 AND q.bucket_time + interval '1 minute' <= now()-interval '1 minute'
WHERE t.user_id=$1 AND b.user_id=$1
 AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'
 AND b.deleted_at IS NULL AND t.account_currency='USD'
 AND t.status='CLOSED' AND t.close_reason='PROFIT_PROTECTION'
 AND t.closed_at >= $2::timestamptz AND t.closed_at<=$3::timestamptz
ORDER BY t.closed_at,t.id,q.bucket_time LIMIT 5001
`;
function number(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null}
function round(n){return Number(n.toFixed(3))}
/**
 * Conservative and strictly separate barrier analysis: the closing-price
 * fields are BROKER sampled, but OHLC high/low are NOT proven executable
 * side-specific BID/ASK extremes. A threshold crossing is only POSSIBLE.
 * The partial minute immediately following a mid-minute exit is unobserved.
 * These results can never certify a hypothetically delayed broker fill.
 */
function strictBarrierPath(trade,quotes,cutoff){
 const closedAt=new Date(trade.closed_at).getTime();
 const stop=number(trade.stop_loss),tp=number(trade.take_profit);
 const entry=number(trade.entry_price),exit=number(trade.exit_price);
 const sign=trade.direction==='BUY'?1:trade.direction==='SELL'?-1:0;
 if(!Number.isFinite(closedAt)||sign===0||[stop,tp,entry,exit].some(x=>x===null||x<=0)||
  sign*(entry-stop)<=0||sign*(tp-entry)<=0)
  return {status:'INVALID_BROKER_BARRIERS'};
 const minute=60000;
 const first=Math.ceil(closedAt/minute)*minute;
 const needed=[];
 for(let at=first;at+minute<=cutoff;at+=minute)needed.push(at);
 if(!needed.length)return {status:'NO_FULL_POSTEXIT_M1_CANDLES'};
 const map=new Map(),duplicates=new Set();
 for(const r of quotes){
  const at=r.bucket_time?new Date(r.bucket_time).getTime():null;
  if(at===null||!Number.isFinite(at))continue;
  if(map.has(at))duplicates.add(at);
  map.set(at,r);
 }
 if(needed.some(at=>duplicates.has(at)))return {status:'DUPLICATE_CANDLE_BUCKET'};
 let potentialStop=false,potentialTarget=false;const marks=[];
 for(const at of needed){
  const r=map.get(at);
  const open=number(r?.open),high=number(r?.high),low=number(r?.low),
   close=number(r?.close),bid=number(r?.bid_close),ask=number(r?.ask_close);
  const positive=number(r?.positive_quote_sample_count);
  const live=r?.last_positive_sample_at?new Date(r.last_positive_sample_at).getTime():null;
  if(!r||r.source!=='ctrader-broker-native'||[open,high,low,close,bid,ask].some(x=>x===null)||
   open<=0||low<=0||bid<=0||ask<=bid||high<Math.max(open,close)||
   low>Math.min(open,close)||!(number(r.sample_count)>=2)||!(positive>=2)||
   live===null||!Number.isFinite(live)||live<at||live>=at+minute)
   return {status:'MISSING_OR_INVALID_NATIVE_CANDLES',expectedBars:needed.length,
     checkedBars:marks.length};
  marks.push(sign===1?bid:ask);
  if(sign===1 ? low<=stop : high>=stop)potentialStop=true;
  if(sign===1 ? high>=tp : low<=tp)potentialTarget=true;
 }
 const pip=trade.instrument.endsWith('JPY')?.01:.0001;
 const last=marks[marks.length-1];
 return {
  status:potentialStop&&potentialTarget?'POSSIBLE_BOTH_BARRIERS':
   potentialStop?'POSSIBLE_STOP_TOUCH':
   potentialTarget?'POSSIBLE_TP_TOUCH':'NO_SAMPLED_BARRIER_TOUCH',
  completedContiguousNativeBars:needed.length,
  possibleStopTouch:potentialStop,possibleTpTouch:potentialTarget,
  unobservedPartialExitMinute:first!==closedAt,
  additionalPipsAtLastBidAskClose:round(sign*(last-exit)/pip),
  noTradeAuthority:true,noBrokerFillProof:true,
 };
}
function summarizeStrictBarriers(details){
 const strictBarrierSummary={};
 for(const minutes of HORIZONS){
  const cases=details.map(d=>d.horizons.find(h=>h.minutes===minutes))
   .filter(h=>h?.status==='MATURE_SAMPLED');
  const strict=cases.map(h=>h.strictBrokerNativeBarrierEvidence);
  const eligible=strict.filter(r=>r?.status==='NO_SAMPLED_BARRIER_TOUCH'||
   r?.status?.startsWith('POSSIBLE_'));
  const clean=eligible.filter(r=>r.status==='NO_SAMPLED_BARRIER_TOUCH');
  strictBarrierSummary[minutes+'m']={
   sampledTradeWindows:cases.length,
   completeContiguousNativeQuotePaths:eligible.length,
   missingOrInvalidNativeQuotePaths:cases.length-eligible.length,
   possibleStopTouches:eligible.filter(r=>r.possibleStopTouch).length,
   possibleTpTouches:eligible.filter(r=>r.possibleTpTouch).length,
   possibleBothBarriers:eligible.filter(r=>r.possibleStopTouch&&r.possibleTpTouch).length,
   cleanQuoteOnlyCases:clean.length,
   cleanAfterExitBetter:clean.filter(r=>r.additionalPipsAtLastBidAskClose>0).length,
   cleanAfterExitWorse:clean.filter(r=>r.additionalPipsAtLastBidAskClose<0).length,
   unobservedExitMinuteCases:eligible.filter(r=>r.unobservedPartialExitMinute).length,
   noBrokerFillsInferred:true,
  };
 }

 return strictBarrierSummary;
}

function summarize(rows,now=new Date()){
 const end=now.getTime(),byTrade=new Map();
 for(const row of rows){
  if(!byTrade.has(row.trade_key))byTrade.set(row.trade_key,{trade:row,quotes:[]});
  const at=row.bucket_time&&new Date(row.bucket_time).getTime();
  const bid=number(row.bid_close),ask=number(row.ask_close);
  if(Number.isFinite(at)&&bid!==null&&ask!==null&&bid>0&&ask>=bid&&Number(row.sample_count)>0)
   byTrade.get(row.trade_key).quotes.push({...row,at,bid,ask});
 }
 const details=[];
 for(const {trade:t,quotes} of byTrade.values()){
  const closedAt=new Date(t.closed_at).getTime(),direction=t.direction;
  const exit=number(t.exit_price),tp=number(t.take_profit);
  if(!Number.isFinite(closedAt)||!['BUY','SELL'].includes(direction)||exit===null||tp===null||exit<=0||tp<=0)continue;
  const pip=t.instrument.endsWith('JPY')?0.01:0.0001;
  const sign=direction==='BUY'?1:-1;
  const periods=HORIZONS.map(minutes=>{
    const cutoff=closedAt+minutes*60000;
    if(end<cutoff+60000) return {minutes,status:'NOT_YET_MATURE'};
    // Only completed post-exit M1 candle closes; never use partial bars.
    const valid=quotes.filter(q=>q.at>=closedAt && q.at+60000<=cutoff);
    if(!valid.length)return {minutes,status:'NO_VALID_BAR_CLOSE'};
    const strict=strictBarrierPath(t,quotes,cutoff);
    const values=valid.map(q=>sign*((direction==='BUY'?q.bid:q.ask)-exit)/pip);
    const marks=valid.map(q=>direction==='BUY'?q.bid:q.ask);
    const atCloseTP=marks.some(p=>sign*(p-tp)>=-1e-9);
    return {minutes,status:'MATURE_SAMPLED',observedBars:valid.length,
      strictBrokerNativeBarrierEvidence:strict,
      bestAdditionalPips:round(Math.max(...values)),
      worstAdditionalPips:round(Math.min(...values)),
      lastAdditionalPips:round(values[values.length-1]),
      tpReachedAtSampledM1Close:atCloseTP};
  });
  const gross=number(t.realised_pnl),fee=number(t.commission),swap=number(t.swap);
  details.push({instrument:t.instrument,direction,closedAt:new Date(closedAt).toISOString(),
    strategyRoute:t.strategy_route,
    realizedNet: gross===null||fee===null||swap===null?null:Math.round((gross+fee+swap)*100)/100,
    exitPrice:exit,originalTP:tp,horizons:periods});
 }
 const matured=details.flatMap(d=>d.horizons.filter(h=>h.status==='MATURE_SAMPLED'));
 const strictBarrierSummary=summarizeStrictBarriers(details);
 const strictBarrierSummaryByRoute={};
 for(const key of ['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION','OTHER']){
  strictBarrierSummaryByRoute[key]=summarizeStrictBarriers(
   details.filter(d=>(d.strategyRoute||'OTHER')===key));
 }
 const strictBarrierSummaryByInstrument={};
 for(const key of ['EURUSD','AUDUSD','USDJPY','USDCAD']){
  strictBarrierSummaryByInstrument[key]=summarizeStrictBarriers(details.filter(d=>d.instrument===key));
 }
 return {artifact:'pepperstone-demo-postexit-bidask-close-study-v1',generatedAt:now.toISOString(),
 scope:'OWNER_PEPPERSTONE_CTRADER_USD_DEMO_PROFIT_PROTECTION',
 authority:'RESEARCH_ONLY',modifiesExecution:false,
 trades:details.length,maturedWindows:matured.length,
 sampledTpCloseHits:matured.filter(h=>h.tpReachedAtSampledM1Close).length,
 strictBarrierSummary,strictBarrierSummaryByRoute,strictBarrierSummaryByInstrument,
 details,limitations:[
 'Full M1 bar OHLC highs and lows are NOT certified executable BID/ASK extrema: original TP/SL crossings are only POSSIBLE, never broker fills.',
 'The fractional exit minute is unobserved before the first complete following M1 bar; a clean sampled path is never certified risk-free.',
 'Only bid/ask values recorded at completed one-minute candle CLOSES are compared. Intraminute TP/SL touches are UNKNOWN.',
 'Hypothetical delayed exits cannot be assumed fillable at M1 closes and could lose protected profit or trigger stop-loss.',
 'Post-exit price movements are HINDSIGHT, not inputs available when the protection decision was made.',
 'A win or saved profit on one episode does not establish a profitable timing policy.',
 'No order, broker position, execution flag, or LIVE account can be changed by this report.'
 ]};
}
async function audit(client,userId,from,to,now=new Date()){
 if(!UUID.test(userId||''))throw Error('INVALID_OWNER_SCOPE');
 await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='25000ms'");
  const rows=(await client.query(SQL,[userId,from,to])).rows;
  if(rows.length>5000)throw Error('AUDIT_TOO_LARGE');
  const report=summarize(rows,now);
  await client.query('COMMIT');
  return report;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
}
async function main(){
 require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg');
 const {getDatabaseSslOptions}=require('../dist/config/database-tls');
 const c=new Client({host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),application_name:'irexpro-postexit-readonly'});
 const now=new Date();
 try{
  await c.connect();
  const report=await audit(c,process.env.VPS_FOREX_SCANNER_USER_ID,'2026-11-17T00:00:00.000Z',now.toISOString(),now);
  const dir=resolve(OUT,'..');mkdirSync(dir,{recursive:true,mode:0o700});
  const tmp=OUT+'.'+process.pid+'.tmp';
  const fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(report,null,2));}finally{closeSync(fd)}
  renameSync(tmp,OUT);
  console.log('PEPPERSTONE_POSTEXIT_READONLY',JSON.stringify(report));
 }finally{await c.end()}
}
module.exports={number,strictBarrierPath,summarize,audit,SQL};
if(require.main===module)main().catch(e=>{console.error('POSTEXIT_AUDIT_FAILED',e.message);process.exitCode=1});
