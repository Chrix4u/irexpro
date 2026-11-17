#!/usr/bin/env node
'use strict';
/**
 * Retroactive validation of genuinely prospective (previously persisted)
 * owner-scoped DEMO forming-candle predictions. No trade execution.
 * M1 quote/native OHLC, M5 native trend OHLC; neither implies a broker fill.
 */
const fs=require('node:fs'),path=require('node:path');
const ARTIFACT='irexpro-owner-demo-forward-candle-outcome-audit-v1';
const PRED_ARTIFACT='irexpro-owner-demo-prospective-candle-shadow-v1';
const ROOT='/home/lightworld/webapps/irexpro-research/forming-candle-predictions';
const FOCUS=['EURUSD','AUDUSD','USDJPY','USDCAD'];
const WIDTH={M1:60000,M5:300000};
const STAGES={M1:[15,45],M5:[15,285]};

function finite(x){
 if(x===null||x===undefined||x==='')return null;
 const n=Number(x);return Number.isFinite(n)?n:null;
}
function safePrediction(p){
 if(!p||p.artifact!==PRED_ARTIFACT||p.researchOnly!==true||
 p.brokerOrderAuthority!==false||p.modifiesExecution!==false||
 p.nextCandleOutcomeKnown!==false||p.afterCostPnlKnown!==false||
 !FOCUS.includes(p.instrument)||!Object.hasOwn(WIDTH,p.timeframe)||
 !['RED_OR_DOWN','COST_SMALL_OR_FLAT','GREEN_OR_UP'].includes(p.predictedNextCandleClass))
 return false;
 const start=Date.parse(p.barStart),at=Date.parse(p.decisionAt);
 const stage=(at-start)/1000;
 const spread=finite(p.observedSpreadPrice),atr=finite(p.causalAtrPrice);
 return Number.isFinite(start)&&Number.isFinite(at)&&STAGES[p.timeframe].includes(stage)&&
 at>start&&at<start+WIDTH[p.timeframe]&&spread!==null&&spread>0&&
 atr!==null&&atr>0&&finite(p.confidence)!==null&&p.confidence>=0&&p.confidence<=1&&
 p.modelTrainedAt&&Number.isFinite(Date.parse(p.modelTrainedAt))&&
 at>Date.parse(p.modelTrainedAt)+60000;
}
function key(p){return [p.decisionAt,p.barStart,p.instrument,p.timeframe].join('|');}
function loadPredictions(dir=ROOT,asOf=new Date()){
 const days=[1,0].map(d=>new Date(asOf.getTime()-d*86400000).toISOString().slice(0,10));
 const rows=[],seen=new Set();
 for(const day of days){
  const f=path.join(dir,day+'.jsonl');if(!fs.existsSync(f))continue;
  if(fs.statSync(f).size>25*1024*1024)throw Error('PREDICTION_FILE_BOUNDS_EXCEEDED');
  for(const line of fs.readFileSync(f,'utf8').split('\n')){
   if(!line)continue;
   let p;try{p=JSON.parse(line)}catch{continue}
   if(!safePrediction(p))continue;
   const id=key(p);
   if(seen.has(id))throw Error('DUPLICATE_PROSPECTIVE_FORECAST_KEY');
   seen.add(id);rows.push(p);
  }
 }
 return rows;
}
function expectedNextBucket(p){return Date.parse(p.barStart)+WIDTH[p.timeframe];}
function outcome(p,candle,asOfMs){
 if(!safePrediction(p))return {status:'REJECTED_INVALID_PROSPECTIVE_FORECAST'};
 const next=expectedNextBucket(p),width=WIDTH[p.timeframe];
 if(next+width+30000>asOfMs)return {status:'NOT_YET_MATURED'};
 if(!candle||candle.instrument!==p.instrument||candle.timeframe!==p.timeframe||
   new Date(candle.bucket_time).getTime()!==next||
   candle.source!=='ctrader-broker-native'||finite(candle.sample_count)<2||
   (p.timeframe==='M1'&&finite(candle.positive_quote_sample_count)<2))
 return {status:'MISSING_NATIVE_COMPLETED_OUTCOME'};
 const o=finite(candle.open),h=finite(candle.high),
 l=finite(candle.low),c=finite(candle.close);
 const spread=finite(p.observedSpreadPrice),atr=finite(p.causalAtrPrice);
 if(o===null||h===null||l===null||c===null||o<=0||l<=0||
 h<Math.max(o,c)||l>Math.min(o,c))
 return {status:'INVALID_NATIVE_CANDLE_GEOMETRY'};
 const threshold=Math.max(spread,.05*atr);
 const body=c-o;
 const actual=body>threshold?'GREEN_OR_UP':
   body< -threshold?'RED_OR_DOWN':'COST_SMALL_OR_FLAT';
 const direction=p.predictedNextCandleClass==='GREEN_OR_UP'?1:
   p.predictedNextCandleClass==='RED_OR_DOWN'?-1:0;
 const afterSpreadAtr=direction===0?null:(direction*body-spread)/atr;
 return {status:'MATCHED_COMPLETED_NEXT_CANDLE',
  actualNextClass:actual,forecastCorrect:actual===p.predictedNextCandleClass,
  directionalForecast:direction!==0,
  spreadOnlyPriceMoveAtr:afterSpreadAtr!==null?Number(afterSpreadAtr.toFixed(6)):null,
  spreadOnlyDirectionalPositive:afterSpreadAtr===null?null:afterSpreadAtr>0,
  labelCostThresholdPrice:threshold,
  notBrokerExecuted:true,commissionUnmodeled:true,
  actualGrossPnlUnknown:true,modelNotPromoted:true,
 };
}
function summarize(items,asOf){
 const groups={};let matched=0,pending=0,missing=0,other=0;
 for(const {p,result} of items){
  if(result.status==='NOT_YET_MATURED'){pending++;continue}
  if(result.status==='MISSING_NATIVE_COMPLETED_OUTCOME'){missing++;continue}
  if(result.status!=='MATCHED_COMPLETED_NEXT_CANDLE'){other++;continue}
  matched++;
  const stage=(Date.parse(p.decisionAt)-Date.parse(p.barStart))/1000;
  const name=[p.timeframe,'at_'+stage+'s',p.instrument].join('|');
  const g=groups[name] ||= {timeframe:p.timeframe,stageSeconds:stage,
    instrument:p.instrument,independentForecasts:0,correct:0,
    directionalForecasts:0,spreadOnlyDirectionalPositive:0,
    confidenceAbove65:0,confidenceAbove65Correct:0,
    spreadOnlySumAtr:0,notAfterCommission:true};
  g.independentForecasts++;if(result.forecastCorrect)g.correct++;
  if(result.directionalForecast){
    g.directionalForecasts++;
    if(result.spreadOnlyDirectionalPositive)g.spreadOnlyDirectionalPositive++;
    g.spreadOnlySumAtr+=result.spreadOnlyPriceMoveAtr;
  }
  if(p.confidence>=.65){g.confidenceAbove65++;
    if(result.forecastCorrect)g.confidenceAbove65Correct++;}
 }
 for(const g of Object.values(groups)){
  g.accuracy=g.independentForecasts?Number((g.correct/g.independentForecasts).toFixed(4)):null;
  g.spreadOnlyPositiveRate=g.directionalForecasts?
    Number((g.spreadOnlyDirectionalPositive/g.directionalForecasts).toFixed(4)):null;
  g.meanSpreadOnlyAtr=g.directionalForecasts?
    Number((g.spreadOnlySumAtr/g.directionalForecasts).toFixed(6)):null;
  g.confidentColorHitRate=g.confidenceAbove65?
    Number((g.confidenceAbove65Correct/g.confidenceAbove65).toFixed(4)):null;
  delete g.spreadOnlySumAtr;
 }
 return {artifact:ARTIFACT,researchOnly:true,modifiesExecution:false,
  promotionAllowed:false,asOf:new Date(asOf).toISOString(),
  source:'PREVIOUSLY_PERSISTED_ASOF_FORECAST_PLUS_LATER_NATIVE_CANDLE',
  inputPredictions:items.length,matchedCompleted:matched,pendingOutcomes:pending,
  missingNativeOutcome:missing,rejectedOrInvalidOutcome:other,
  byFixedStageInstrument:groups,
  limitations:[
   'One prediction per instrument/bar/stage; different stages of the same bar are correlated and must not be added as independent episodes.',
   'The forecast was persisted before the following bar matured. Current or future OHLC cannot retroactively change prediction fields.',
   'Historical next-candle body after contemporaneous spread is NOT an executable entry/exit fill and does NOT include commission, slippage, SL/TP path, margin, or financing.',
   'Insufficient market days and no independent after-cost evidence: neither model qualifies for broker execution.',
  ]};
}
async function audit({asOf=new Date(),dir=ROOT}={}){
 require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!owner)throw Error('EXACT_OWNER_ID_REQUIRED');
 const predictions=loadPredictions(dir,asOf),{Client}=require('pg');
 const db=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),
  database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false,statement_timeout:12000});
 let candles=[];
 try{
  await db.connect();await db.query('BEGIN READ ONLY');
  const broker=await db.query(
   "SELECT id FROM broker.broker_connections WHERE user_id=$1 "+
   "AND broker_id='pepperstone-ctrader' AND account_type='DEMO' "+
   "AND account_currency='USD' AND deleted_at IS NULL "+
   "ORDER BY created_at DESC LIMIT 1",[owner]);
  if(broker.rows.length!==1)throw Error('OWNER_DEMO_USD_BROKER_UNVERIFIED');
  if(predictions.length){
   const start=new Date(Math.min(...predictions.map(expectedNextBucket))-60000);
   const rows=await db.query(
    "SELECT instrument,timeframe,bucket_time,open,high,low,close,source,"+
    "sample_count,positive_quote_sample_count "+
    "FROM market_data.provider_quote_candles "+
    "WHERE connection_id=$1 AND instrument=ANY($2::text[]) "+
    "AND timeframe=ANY($3::text[]) AND source='ctrader-broker-native' "+
    "AND bucket_time >= $4::timestamptz "+
    "AND bucket_time <= $5::timestamptz "+
    "ORDER BY bucket_time",
    [broker.rows[0].id,FOCUS,Object.keys(WIDTH),start,asOf]);
   candles=rows.rows;
  }
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{await db.end()}
 const indexed=new Map();
 for(const c of candles)indexed.set([c.instrument,c.timeframe,new Date(c.bucket_time).getTime()].join('|'),c);
 const items=predictions.map(p=>{
  const k=[p.instrument,p.timeframe,expectedNextBucket(p)].join('|');
  return {p,result:outcome(p,indexed.get(k),asOf.getTime())};
 });
 return summarize(items,asOf);
}
async function main(){
 const watch=process.argv.includes('--watch');
 let busy=false;
 const attempt=async()=>{
  if(busy)return;
  busy=true;
  try{
   const report=await audit();
   const dst=path.join('/home/lightworld/webapps/irexpro-research/forming-candle-predictions',
     'latest-outcome-audit.json');
   const tmp=dst+'.tmp-'+process.pid;
   fs.writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
   fs.renameSync(tmp,dst);
   if(!watch)console.log(JSON.stringify(report,null,2));
   else console.log('FORWARD_CANDLE_OUTCOME_AUDIT',JSON.stringify({
     at:report.asOf,forecasts:report.inputPredictions,
     matched:report.matchedCompleted,pending:report.pendingOutcomes,
     missing:report.missingNativeOutcome,researchOnly:true,
     brokerOrders:false,databaseWrites:false,promotionAllowed:false,
   }));
  }catch(e){
   if(!watch)throw e;
   console.error('FORWARD_CANDLE_OUTCOME_AUDIT_REJECTED',String(e.message).slice(0,220));
  }finally{busy=false;}
 };
 await attempt();
 if(watch){
  const timer=setInterval(()=>void attempt(),300000);
  const stop=()=>{clearInterval(timer);process.exit(0)};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
 }
}
module.exports={ARTIFACT,safePrediction,key,expectedNextBucket,outcome,summarize,loadPredictions,audit};
if(require.main===module)main().catch(e=>{console.error('FORWARD_CANDLE_AUDIT_FAILED',String(e.message).slice(0,240));process.exitCode=1});
