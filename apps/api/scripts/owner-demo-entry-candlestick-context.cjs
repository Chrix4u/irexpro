'use strict';
/**
 * Signed/candle-body fingerprints from CLOSED and truly as-of broker-native
 * EURUSD/AUDUSD/USDJPY/USDCAD M1/M5 records. Pure research features,
 * NEVER permission to enter, reverse, resize, or close a position.
 */
const SOURCE='ctrader-broker-native';
const QUERY=[
 'SELECT timeframe,bucket_time,open,high,low,close,source,',
 'sample_count,positive_quote_sample_count,last_sample_at,created_at,updated_at',
 'FROM market_data.provider_quote_candles',
 'WHERE connection_id=$1 AND instrument=$2',
 "AND source='ctrader-broker-native'",
 "AND timeframe IN ('M1','M5')",
 "AND (CASE WHEN timeframe='M1' THEN bucket_time+interval '1 minute'",
 "ELSE bucket_time+interval '5 minutes' END)<=$3::timestamptz",
 'AND last_sample_at<=$3::timestamptz',
 'AND created_at<=$3::timestamptz',
 'AND updated_at<=$3::timestamptz',
 "AND bucket_time>=$3::timestamptz-interval '22 minutes'",
 'ORDER BY bucket_time DESC LIMIT 35',
].join(' ');
const num=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const round=(n,d=3)=>Number(n.toFixed(d));
function parseAsOfCandle(row,at){
 const decision=ms(at),start=ms(row.bucket_time),
  first=ms(row.created_at),updated=ms(row.updated_at),sample=ms(row.last_sample_at);
 const width=row.timeframe==='M1'?60000:row.timeframe==='M5'?300000:NaN;
 const o=num(row.open),h=num(row.high),l=num(row.low),c=num(row.close);
 if(row.source!==SOURCE||!Number.isFinite(decision)||
    !Number.isFinite(start)||!Number.isFinite(width)||
    !Number.isFinite(first)||!Number.isFinite(updated)||!Number.isFinite(sample)||
    start+width>decision||first>decision||updated>decision||sample>decision||
    first<start||sample<start||sample>=start+width+1000||
    num(row.sample_count)<2||(row.timeframe==='M1'&&num(row.positive_quote_sample_count)<2)||
    [o,h,l,c].some(x=>x===null||x<=0)||h<=l||
    h<Math.max(o,c)||l>Math.min(o,c))return null;
 const extent=h-l,upper=(h-Math.max(o,c))/extent,
  lower=(Math.min(o,c)-l)/extent,body=Math.abs(c-o)/extent;
 const label=upper>=.57?'LONG_UPPER_REJECTION_WICK':
   lower>=.57?'LONG_LOWER_REJECTION_WICK':
   body<=.12?'DOJI_SMALL_BODY':
   body>=.7?(c>o?'BULL_WIDE_BODY':'BEAR_WIDE_BODY'):
   c>o?'BULL_MIXED_BODY':c<o?'BEAR_MIXED_BODY':'DOJI_SMALL_BODY';
 return {
  timeframe:row.timeframe,barStart:new Date(start).toISOString(),
  open:o,high:h,low:l,close:c,
  candleLabel:label,bodyRangeRatio:round(body),
  upperWickRatio:round(upper),lowerWickRatio:round(lower),
  independentlyCompletedBeforeDecision:true,
 };
}
function buildPreEntryCandleContext(rows,decisionAt){
 const at=ms(decisionAt),by={M1:[],M5:[]};
 for(const row of rows||[]){
  const c=parseAsOfCandle(row,at);
  if(c&&by[c.timeframe].length<3)by[c.timeframe].push(c);
 }
 const summary=(tf)=>{
  const selected=by[tf],recent=selected[0];
  if(!recent)return {state:'NO_VERIFIED_AS_OF_CANDLES',candleCount:0,candles:[]};
  const width=tf==='M1'?60000:300000;
  const completed=ms(recent.barStart)+width;
  const ageMinutes=(at-completed)/60000;
  if(ageMinutes>(tf==='M1'?3:10))
   return {state:'STALE_COMPLETED_CANDLES',candleCount:selected.length,
     freshnessMinutes:round(ageMinutes),candles:[]};
  const prev=selected[1],
   adjacent=prev&&ms(recent.barStart)-ms(prev.barStart)===width;
  const engulf=Boolean(adjacent &&
    ((recent.close>recent.open&&prev.close<prev.open&&
      recent.open<=prev.close&&recent.close>=prev.open)||
     (recent.close<recent.open&&prev.close>prev.open&&
      recent.close<=prev.open&&recent.open>=prev.close)));
  return {state:'VERIFIED_COMPLETED_AS_OF_ENTRY',
   candleCount:selected.length,freshnessMinutes:round(ageMinutes),
   latestCandle:recent.candleLabel,engulfingIfAdjacent:engulf,
   candles:selected};
 };
 return {mode:'FROZEN_BROKER_NATIVE_PRE_ENTRY_CANDLES_ONLY',
  evaluatedAt:new Date(at).toISOString(),
  M1:summary('M1'),M5:summary('M5'),
  noMarketOutcomeLeakage:true,noTradingAuthority:true};
}
async function fetchForOpenDecision(client,row){
 const connection=row.broker_connection_id,inst=row.instrument,at=row.decision_at;
 if(!connection||!['EURUSD','AUDUSD','USDJPY','USDCAD'].includes(inst)||
    !Number.isFinite(ms(at)))return buildPreEntryCandleContext([],new Date());
 const result=await client.query(QUERY,[connection,inst,at]);
 if(!Array.isArray(result?.rows)||result.rows.length>35)
  throw Error('ASOF_CANDLE_BOUND_VIOLATION');
 return buildPreEntryCandleContext(result.rows,at);
}
module.exports={SOURCE,QUERY,parseAsOfCandle,buildPreEntryCandleContext,fetchForOpenDecision};
