'use strict';
// MAIN is a real Pepperstone DEMO position; COUNTER is a matched virtual mirror.
// Read-only research; never calls broker trade execution or modifies risk rules.
const fs=require('node:fs'),path=require('node:path');
const OUTPUT='/home/lightworld/webapps/irexpro-research/counter-direction/latest-report.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const money=n=>Number(n.toFixed(2));
const iso=v=>new Date(v).toISOString();
const minute=v=>Math.floor(new Date(v).getTime()/60000);
const other=d=>d==='BUY'?'SELL':d==='SELL'?'BUY':null;
function validQuote(q){
 return q?.source==='ctrader-broker-native'&&num(q.positive_quote_sample_count)>0&&
   num(q.last_positive_spread)>0&&num(q.last_positive_bid)>0&&
   num(q.last_positive_ask)>num(q.last_positive_bid);
}
function evaluatePair(row,asOf=new Date()){
 const opened=new Date(row.opened_at);
 const closed=row.closed_at?new Date(row.closed_at):null;
 const gross=num(row.realised_pnl),fee=num(row.commission),swap=num(row.swap);
 const entry=num(row.fill_price),exit=num(row.exit_price),lot=num(row.lot_size);
 const stop=num(row.stop_loss),target=num(row.take_profit);
 const opposite=other(row.direction),id=String(row.id);
 const main={
  label:'MAIN',id:'MAIN:'+id,linkedCounter:'COUNTER_SIM:'+id,
  instrument:row.instrument,direction:row.direction,lotSize:lot,
  openedAt:iso(opened),closedAt:closed?iso(closed):null,
  state:row.status,closeReason:row.close_reason??null,
  netUsd:row.status==='CLOSED'&&gross!==null&&fee!==null&&swap!==null?
    money(gross+fee+swap):null,
  openMarkEstimateNetUsd:null,
  provenance:'ACTUAL_PEPPERSTONE_DEMO_BROKER_FILL'
 };
 const counter={
  label:'COUNTER',id:'COUNTER_SIM:'+id,linkedMain:'MAIN:'+id,
  instrument:row.instrument,direction:opposite,lotSize:lot,
  openedAt:iso(opened),closedAt:closed?iso(closed):null,
  state:'UNRESOLVED',isBrokerOrder:false,executionAuthority:'NONE',
  provenance:'VIRTUAL_QUOTE_SPREAD_PROXY_NOT_BROKER_FILL',
  matchedHorizonNetUsd:null,mirroredBarrierNetUsd:null,
  openMarkEstimateNetUsd:null,estimatedRoundTripCommissionUsd:null,
  barrierOutcome:'UNRESOLVED',firstBarrierAt:null,
  entryProxyPrice:null,exitProxyPrice:null,
  entrySpreadProxy:null,exitSpreadProxy:null,
  missingCandleMinutes:null,reason:null
 };
 const result={pairId:id,main,counter};
 if(row.status==='OPEN'&&opposite&&entry&&lot&&lot>0&&
    asOf.getTime()>=opened.getTime()){
  // Open-position monitor uses recently observed cTrader positive M1 quotes.
  // Both open P&L numbers are estimates; broker balance/marks are authoritative.
  const quotes=(Array.isArray(row.quotes)?row.quotes:[])
    .filter(validQuote).sort((a,b)=>minute(a.bucket_time)-minute(b.bucket_time));
  const first=quotes.find(q=>minute(q.bucket_time)===minute(opened));
  const last=quotes[quotes.length-1];
  if(!first||!last||minute(asOf)-minute(last.bucket_time)>2){
    counter.reason='WAITING_FOR_FRESH_NATIVE_BROKER_QUOTES';
    return result;
  }
  const spread=num(first.last_positive_spread);
  const bid=num(last.last_positive_bid),ask=num(last.last_positive_ask);
  if(!spread||!bid||!ask||ask<=bid){
    counter.reason='QUOTE_SIDE_UNVERIFIED';return result;
  }
  const perPrice=lot*100000*(row.instrument.endsWith('USD')?1:
    row.instrument.startsWith('USD')?1/((bid+ask)/2):NaN);
  if(!Number.isFinite(perPrice)){
    counter.reason='USD_QUOTE_CONVERSION_UNVERIFIED';return result;
  }
  const counterEntry=opposite==='BUY'?entry+spread:entry-spread;
  const mainExitMark=row.direction==='BUY'?bid:ask;
  const counterExitMark=opposite==='BUY'?bid:ask;
  const commissionReserve=6*lot; // Historical observed demo commission, not a fee guarantee.
  main.openMarkEstimateNetUsd=money(
    (row.direction==='BUY'?1:-1)*(mainExitMark-entry)*perPrice-commissionReserve);
  counter.openMarkEstimateNetUsd=money(
    (opposite==='BUY'?1:-1)*(counterExitMark-counterEntry)*perPrice-commissionReserve);
  counter.estimatedRoundTripCommissionUsd=money(commissionReserve);
  counter.entryProxyPrice=+counterEntry.toFixed(6);
  counter.entrySpreadProxy=+spread.toFixed(6);
  counter.state='VIRTUAL_MONITORED_OPEN';
  counter.reason='LATEST_NATIVE_BROKER_M1_MARK_WITH_ESTIMATED_FEE';
  return result;
 }
 if(!opposite||!Number.isFinite(opened.getTime())||
  !entry||!lot||lot<=0||!stop||!target||row.status!=='CLOSED'||!closed||
  !Number.isFinite(closed.getTime())||!exit||gross===null||fee===null||swap===null){
   counter.reason=row.status==='OPEN'?'WAITING_FOR_MAIN_CLOSE':'INVALID_OR_INCOMPLETE_MAIN';
   return result;
 }
 // FX conversion is calibrated from MAIN actual booked gross and price delta;
 // this is approximate, not a true broker quote-currency conversion feed.
 const mainDelta=(row.direction==='BUY'?1:-1)*(exit-entry);
 if(Math.abs(mainDelta)<1e-10||Math.abs(gross)<1e-8||gross*mainDelta<=0){
   counter.reason='UNVERIFIED_ACCOUNT_CURRENCY_CONVERSION';return result;
 }
 const usdPerPrice=Math.abs(gross/mainDelta);
 const quotes=(Array.isArray(row.quotes)?row.quotes:[])
   .filter(validQuote)
   .sort((a,b)=>minute(a.bucket_time)-minute(b.bucket_time));
 const entryQuote=quotes.find(q=>minute(q.bucket_time)===minute(opened));
 const exitQuote=quotes.find(q=>minute(q.bucket_time)===minute(closed));
 if(!entryQuote||!exitQuote){
  counter.reason='BROKER_ENTRY_OR_EXIT_SPREAD_UNAVAILABLE';return result;
 }
 const entrySpread=num(entryQuote.last_positive_spread);
 const exitSpread=num(exitQuote.last_positive_spread);
 if(!entrySpread||!exitSpread){
  counter.reason='POSITIVE_SPREAD_EVIDENCE_UNAVAILABLE';return result;
 }
 // In the quote proxy, MAIN BUY fills ask, counter SELL fills bid.
 // MAIN SELL fills bid, counter BUY fills ask; closing roles likewise swap.
 const counterEntry=opposite==='BUY'?entry+entrySpread:entry-entrySpread;
 const counterExit=opposite==='BUY'?exit-exitSpread:exit+exitSpread;
 const sign=opposite==='BUY'?1:-1;
 const roundTripCommission=-Math.abs(fee);
 const counterGross=sign*(counterExit-counterEntry)*usdPerPrice;
 counter.matchedHorizonNetUsd=money(counterGross+roundTripCommission+swap);
 counter.entryProxyPrice=+counterEntry.toFixed(6);
 counter.exitProxyPrice=+counterExit.toFixed(6);
 counter.entrySpreadProxy=+entrySpread.toFixed(6);
 counter.exitSpreadProxy=+exitSpread.toFixed(6);
 counter.state='MATCHED_HORIZON_VIRTUAL_ESTIMATE';
 counter.reason='SAME_MAIN_EXIT_TIME_WITH_SPREAD_AND_COMMISSION_PROXY';
 // Independent mirrored barriers: only completed M1 buckets after entry.
 // No assumption is made about the unobservable partial entry minute.
 const risk=Math.abs(entry-stop),reward=Math.abs(target-entry);
 const mirrorStop=opposite==='BUY'?counterEntry-risk:counterEntry+risk;
 const mirrorTake=opposite==='BUY'?counterEntry+reward:counterEntry-reward;
 const byMinute=new Map(quotes.map(q=>[minute(q.bucket_time),q]));
 let missing=0;
 for(let m=minute(opened)+1;m<=minute(closed);m++){
  const q=byMinute.get(m);
  if(!q){missing++;continue;}
  if(missing){counter.barrierOutcome='UNRESOLVED_MISSING_M1_DATA';break;}
  const spread=num(q.last_positive_spread),high=num(q.high),low=num(q.low);
  if(spread===null||high===null||low===null){missing++;continue;}
  const buyHigh=high-spread/2,buyLow=low-spread/2;
  const sellHigh=high+spread/2,sellLow=low+spread/2;
  const stops=opposite==='BUY'?buyLow<=mirrorStop:sellHigh>=mirrorStop;
  const takes=opposite==='BUY'?buyHigh>=mirrorTake:sellLow<=mirrorTake;
  if(stops&&takes){counter.barrierOutcome='AMBIGUOUS_BOTH_BARRIERS_SAME_MINUTE';break;}
  if(stops||takes){
    counter.barrierOutcome=stops?'VIRTUAL_STOP_FIRST':'VIRTUAL_TP_FIRST';
    counter.firstBarrierAt=iso(q.bucket_time);
    const barrierPrice=stops?mirrorStop:mirrorTake;
    counter.mirroredBarrierNetUsd=money(
      sign*(barrierPrice-counterEntry)*usdPerPrice+roundTripCommission+swap);
    break;
  }
 }
 counter.missingCandleMinutes=missing;
 if(counter.barrierOutcome==='UNRESOLVED'){
  counter.barrierOutcome=missing?'UNRESOLVED_MISSING_M1_DATA':'VIRTUAL_MATCHED_MAIN_CLOSE';
  if(!missing)counter.mirroredBarrierNetUsd=counter.matchedHorizonNetUsd;
 }
 counter.mirroredStopPrice=+mirrorStop.toFixed(6);
 counter.mirroredTargetPrice=+mirrorTake.toFixed(6);
 counter.entryPartialMinuteSkipped=true;
 counter.firstHitIsApproximate=true;
 return result;
}
const SQL="SELECT t.id,t.instrument,t.direction,t.lot_size,t.opened_at,t.closed_at,t.status,t.close_reason,t.fill_price,t.exit_price,t.stop_loss,t.take_profit,t.realised_pnl,t.commission,t.swap,COALESCE(q.quotes,'[]'::jsonb) quotes FROM (SELECT t.* FROM trading.trades t JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id WHERE t.user_id=$1 AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO' AND b.deleted_at IS NULL AND t.account_currency='USD' AND t.opened_at >= $2::timestamptz ORDER BY t.opened_at DESC,t.id DESC LIMIT $3::int) t LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('bucket_time',x.bucket_time,'high',x.high,'low',x.low,'last_positive_spread',x.last_positive_spread,'last_positive_bid',x.last_positive_bid,'last_positive_ask',x.last_positive_ask,'positive_quote_sample_count',x.positive_quote_sample_count,'source',x.source) ORDER BY x.bucket_time) quotes FROM (SELECT bucket_time,high,low,last_positive_spread,last_positive_bid,last_positive_ask,positive_quote_sample_count,source FROM market_data.provider_quote_candles WHERE connection_id=t.broker_connection_id AND instrument=t.instrument AND timeframe='M1' AND bucket_time>=date_trunc('minute',t.opened_at) AND bucket_time<=date_trunc('minute',COALESCE(t.closed_at,$4::timestamptz)) AND bucket_time<t.opened_at+interval '4 hours' ORDER BY bucket_time LIMIT 241) x) q ON true ORDER BY t.opened_at DESC,t.id DESC";
function reportFor(rows,asOf=new Date()){
 const paired=rows.map(row=>evaluatePair(row,asOf)),daily={};
 for(const p of paired){
  const day=p.main.openedAt.slice(0,10);
  const t=daily[day]??={trades:0,mainClosed:0,mainWins:0,mainLosses:0,
   actualMainNetUsd:0,counterComparable:0,counterWins:0,counterLosses:0,
   virtualCounterMatchedNetUsd:0,pairedNetUsd:0,unresolvedCounter:0};
  t.trades++;
  if(p.main.netUsd!==null){
    t.mainClosed++;t.actualMainNetUsd+=p.main.netUsd;
    if(p.main.netUsd>0)t.mainWins++;
    if(p.main.netUsd<0)t.mainLosses++;
  }
  const c=p.counter;
  if(c.matchedHorizonNetUsd===null){t.unresolvedCounter++;continue;}
  t.counterComparable++;t.virtualCounterMatchedNetUsd+=c.matchedHorizonNetUsd;
  t.pairedNetUsd+=p.main.netUsd+c.matchedHorizonNetUsd;
  if(c.matchedHorizonNetUsd>0)t.counterWins++;
  if(c.matchedHorizonNetUsd<0)t.counterLosses++;
 }
 for(const t of Object.values(daily))
  for(const name of ['actualMainNetUsd','virtualCounterMatchedNetUsd','pairedNetUsd'])
    t[name]=money(t[name]);
 return {
  artifact:'irexpro-main-counter-pepperstone-virtual-v1',
  generatedAt:iso(asOf),scope:'OWNER_PEPPERSTONE_CTRADER_USD_DEMO',
  labels:{MAIN:'ACTUAL_BROKER',COUNTER:'VIRTUAL_PAIRED_SHADOW'},
  executionAuthority:'NONE',modifiesTrading:false,
  limitations:[
   'COUNTER is virtual, never a broker order; there is no guarantee an opposite real order would fill.',
   'Both entry and exit spread proxies use containing minute broker candle, not exact-timestamp spreads.',
   'Matched-horizon counter P&L assumes identical volume and exit timestamp to MAIN, not independently optimized exit.',
   'Mirrored independent SL/TP first-hit uses completed M1 high/low and cannot establish tick-level ordering.',
   'The entry minute is omitted from barrier-first inference; early touches are not observable.',
   'Missing candle or conversion evidence leaves unresolvable simulations explicitly unpriced.',
   'Same-size simultaneous opposite real positions would pay two sets of spread and commission.',
   'These scores are not proof of profitable execution and must not promote LIVE trading.'
  ],daily,paired
 };
}
async function run(client,userId,asOf=new Date()){
 if(!UUID.test(userId||''))throw Error('UNVERIFIED_OWNER_SCOPE');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='20000ms'");
  const from=new Date(asOf.getTime()-4*86400000);
  const rows=(await client.query(SQL,[userId,from.toISOString(),80,iso(asOf)])).rows;
  await client.query('COMMIT');
  return reportFor(rows,asOf);
 }catch(e){await client.query('ROLLBACK');throw e;}
}
async function main(){
 require('dotenv').config({path:process.env.IREXPRO_API_ENV_PATH||
  path.resolve(__dirname,'../.env'),quiet:true});
 const{Client}=require('pg'),{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const dbOpts={host:process.env.DB_HOST||'localhost',port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME||'irexpro_dev',user:process.env.DB_USER||'irexpro',
  password:process.env.DB_PASSWORD,ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  connectionTimeoutMillis:8000,query_timeout:22000,
  application_name:'irexpro-main-counter-virtual-readonly'};
 let busy=false,lastLogSignature=null;
 async function step(){
  if(busy)return;busy=true;const c=new Client(dbOpts);
  try{
   await c.connect();const report=await run(c,process.env.VPS_FOREX_SCANNER_USER_ID);
   fs.mkdirSync(path.dirname(OUTPUT),{recursive:true,mode:0o700});
   const temp=OUTPUT+'.tmp';
   fs.writeFileSync(temp,JSON.stringify(report,null,2),{mode:0o600});
   fs.renameSync(temp,OUTPUT);
   // Keep VPS PM2 logs small: only write when a trade count or paired
   // outcome changes. The private report itself refreshes every 120 seconds.
   const comparable=report.paired.filter(
    p=>p.counter.matchedHorizonNetUsd!==null).length;
   const unresolved=report.paired.filter(
    p=>p.counter.matchedHorizonNetUsd===null).length;
   const signature=JSON.stringify({daily:report.daily,comparable,unresolved,
    openPairs:report.paired.filter(p=>p.main.state==='OPEN').map(p=>({
      id:p.pairId,mainMark:p.main.openMarkEstimateNetUsd,
      counterMark:p.counter.openMarkEstimateNetUsd
    }))});
   if(signature!==lastLogSignature){
    console.log('COUNTER_SHADOW',JSON.stringify({
      at:report.generatedAt,daily:report.daily,comparable,unresolved
    }));
    lastLogSignature=signature;
   }
  }catch(e){console.error('COUNTER_SHADOW_ERROR',String(e.message).slice(0,200))}
  finally{await c.end().catch(()=>{});busy=false;}
 }
 await step();
 if(process.argv.includes('--watch'))setInterval(step,120000);
}
module.exports={evaluatePair,reportFor,run,SQL,validQuote};
if(require.main===module)main().catch(e=>{
 console.error('COUNTER_SHADOW_FAILED',e.message);process.exitCode=1;
});
