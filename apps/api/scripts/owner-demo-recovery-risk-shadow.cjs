'use strict';
/**
 * iRexPro owner USD DEMO: pure, outcome-blind post-entry recovery-pressure
 * research. NOT trained/calibrated probabilities, NOT a trading instruction.
 */
const ARTIFACT='irexpro-owner-demo-recovery-5-10-15-20m-shadow-v1';
const EARLY_CAUTION_ARTIFACT='irexpro-demo-early-fee-covered-profit-fade-research-v1';
const HORIZONS=Object.freeze([5,10,15,20]);
const CHECKPOINTS=Object.freeze([1,2,3,4,5,6,8,10,12,15,18,20,25,30,40,50,60]);
const INSTRUMENTS=Object.freeze(['EURUSD','AUDUSD','USDJPY','USDCAD']);
const ROUTES=Object.freeze(['EARLY_TRANSITION','CONFIRMED_REVERSAL']);
const n=x=>x===null||x===undefined||x===''?null:Number.isFinite(+x)?+x:null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const rnd=(x,k=3)=>x==null||!Number.isFinite(x)?null:+x.toFixed(k);
const pip=s=>s.endsWith('JPY')?.01:.0001;

function quote(row,now){
 const start=ms(row.bucket_time),sample=ms(row.last_positive_sample_at),
  created=ms(row.created_at),updated=ms(row.updated_at);
 const bid=n(row.last_positive_bid),ask=n(row.last_positive_ask);
 if(row.source!=='ctrader-broker-native'||row.timeframe!=='M1'||
  !Number.isFinite(start)||!Number.isFinite(sample)||
  !Number.isFinite(created)||!Number.isFinite(updated)||
  start+60000>now||sample>now||created>now||updated>now||
  sample<start+30000||sample>=start+60000||
  n(row.sample_count)<2||n(row.positive_quote_sample_count)<2||
  !(bid>0&&ask>bid))return null;
 return {barStart:start,completedAt:start+60000,sampledAt:sample,
  bid,ask,spreadPips:rnd((ask-bid)/pip(row.instrument),3),
  brokerNative:true,asOfVerified:true};
}
function newest(quotes,now){
 return (quotes||[]).filter(x=>x.completedAt<=now&&now-x.completedAt<=85000)
  .sort((a,b)=>b.completedAt-a.completedAt)[0]||null;
}
function atOffset(quotes,last,minutes){
 const target=last.barStart-minutes*60000;
 return quotes.find(q=>q.barStart===target)||null;
}
/**
 * Early, fee-covered profit fading signal. This is intentionally only an
 * observational research candidate: M1 adverse while M3 is not yet adverse.
 * It MUST NOT enter the severe-warning/automatic exit cohort.
 */
function earlyProfitFade({fee,peak,gross,net,m1,m3,bufferR}){
 const hasEvidence=[fee,peak,gross,net,m1,m3,bufferR]
  .every(Number.isFinite);
 if(!hasEvidence||!(fee>0)||!(peak>fee*1.5)||
  !(net>0)||!(gross>0)||!(bufferR>.35))return false;
 const retainedGrossFraction=gross/peak;
 return retainedGrossFraction<.8&&retainedGrossFraction>.20&&
  m1<=-.055&&m3>-.11;
}
function evaluate(row,quotes,now,feeReserve){
 const base={artifact:ARTIFACT,at:new Date(now).toISOString(),
  route:row.route,side:row.direction,pair:row.instrument,
  researchOnly:true,noTradingAuthority:true,noBrokerOrders:true,
  noStopChanges:true,noProfitProtectionChanges:true,calibratedProbability:null,
  notAClaimThatRecoveryIsImpossible:true};
 const opened=ms(row.opened_at),fill=n(row.fill_price),stop=n(row.stop_loss),
  lots=n(row.lot_size),sign=row.direction==='BUY'?1:-1;
 if(!ROUTES.includes(row.route)||!INSTRUMENTS.includes(row.instrument)||
  !['BUY','SELL'].includes(row.direction)||!(fill>0)||!(stop>0)||
  !(lots>0)||!Number.isFinite(opened)||opened>now||
  !(sign*(fill-stop)>0))return {...base,state:'INVALID_VERIFIED_ENTRY'};
 const last=newest(quotes,now);
 if(!last)return {...base,state:'NO_FRESH_BROKER_NATIVE_QUOTE'};
 const risk=Math.abs(fill-stop),side=sign===1?last.bid:last.ask;
 const movement=sign*(side-fill),buffer=sign*(side-stop);
 const quoteGross=movement*lots*100000/
  (row.instrument.startsWith('USD')?side:1);
 const fee=n(feeReserve);
 const netEstimate=fee>0?quoteGross-fee:null;
 const change=(minutes)=>{
  const earlier=atOffset(quotes,last,minutes);
  return earlier?rnd(sign*(side-(sign===1?earlier.bid:earlier.ask))/risk,4):null;
 };
 const m1=change(1),m3=change(3),m5=change(5);
 const adverse1=m1!==null&&m1<-.035,adverse3=m3!==null&&m3<-.11;
 const peak=n(row.max_favorable_pnl),giveback=n(row.profit_giveback);
 const pathAt=ms(row.path_last_observed_at);
 const timelyPath=Number.isFinite(pathAt)&&pathAt<=now&&now-pathAt<=35000&&
  peak!==null&&giveback!==null&&giveback>=0;
 const peakCoveredFee=timelyPath&&fee>0&&peak>fee*1.15;
 const atRisk=buffer/risk<.35;
 const momentumOpposes=adverse1&&adverse3;
 const earlyFade=earlyProfitFade({fee,peak:timelyPath?peak:null,
  gross:quoteGross,net:netEstimate,m1,m3,bufferR:buffer/risk});
 let state='INSUFFICIENT_MOMENTUM_EVIDENCE';
 if(m1!==null&&m3!==null){
  state='NO_STRONG_REVERSAL_WARNING';
  if(atRisk&&adverse1)state='TOWARD_ORIGINAL_STOP';
  else if(momentumOpposes&&peakCoveredFee&&giveback>peak*.4)
   state='POSITIVE_PEAK_GIVEBACK_WITH_COUNTER_MOMENTUM';
  else if(momentumOpposes)state='COUNTER_MOMENTUM_WATCH';
 }
 const detail={...base,state,assessedAt:new Date(now).toISOString(),
  quoteCompletedAt:new Date(last.completedAt).toISOString(),
  quoteSampledAt:new Date(last.sampledAt).toISOString(),
  quoteAgeSeconds:rnd((now-last.sampledAt)/1000,1),spreadPips:last.spreadPips,
  positionAgeMinutes:rnd((now-opened)/60000,2),filledLots:lots,
  grossMarketMarkEstimateUsd:rnd(quoteGross,2),
  hypotheticalNetAfterFeeEstimateUsd:rnd(netEstimate,2),
  feeReserveUsd:fee,feeEstimateVerified:fee>0,
  originalStopHeadroomR:rnd(buffer/risk,4),
  currentPriceMovementR:rnd(movement/risk,4),
  alignedLast1mR:m1,alignedLast3mR:m3,alignedLast5mR:m5,
  recordedPeakBrokerPnlUsd:timelyPath?peak:null,
  recordedGivebackBrokerPnlUsd:timelyPath?giveback:null,
  recordedPeakAboveFeeReserve:peakCoveredFee,
  peakDataFresh:timelyPath,
  // Standalone early caution: does NOT alter 'state', confidence,
  // strategy rules or profit protection, even when it fires.
  earlyFeeCoveredProfitFadeWatchOnly:earlyFade,
  earlyFadeRuleArtifact:EARLY_CAUTION_ARTIFACT,
  earlyFadeLabel:earlyFade?'NET_PROFIT_FADING_M1_FIRST_TURN':'NONE',
  earlyFadeTheoreticalRemainingNetUsd:earlyFade?rnd(netEstimate,2):null,
  earlyFadeExitFillAvailable:false,
  earlyFadeMayRecoverAndMakeMoreProfit:true,
  watchOnly:true,requiresIndependentProspectiveValidation:true,
  hypotheticalMarkedNetNotBrokerCloseFill:true,
  horizons:Object.fromEntries(HORIZONS.map(h=>[h,{
   horizonMinutes:h,scenario:state,
   predictedPriceRecoveryProbability:null,
   actualOutcome:'PENDING_AS_OF_SNAPSHOT',
   noAutomaticClose:true,
   futureAt:new Date(now+h*60000).toISOString(),
  }])),
 };
 return detail;
}
function asOfCheckpoint(row,openAt,now){
 const opened=ms(openAt),age=(now-opened)/60000;
 if(row.status!=='OPEN'||!Number.isFinite(opened)||age<1)return null;
 return CHECKPOINTS.find(m=>age>=m&&age<m+.5)||null;
}
function labelMature(record,row,quotes,now,feeReserve){
 const due=ms(record.assessedAt)+record.horizonMinutes*60000;
 const closed=ms(row.closed_at);
 if(now<due)return null;
 // Actual close is an outcome, not a counterfactual forecast of an early exit.
 if(row.status==='CLOSED'&&Number.isFinite(closed)&&closed<=due){
  const gross=n(row.realised_pnl),fee=n(row.commission),swap=n(row.swap);
  return {state:'ACTUAL_POSITION_CLOSED_BEFORE_HORIZON',
   horizonMinutes:record.horizonMinutes,
   actualBrokerNetUsd:[gross,fee,swap].every(v=>v!==null)?
    rnd(gross+fee+swap,2):null,
   actualCloseReason:row.close_reason||'UNVERIFIED',
   providerStopHitUnverified:true,noCounterfactualProfitClaim:true};
 }
 // Never reconstruct after the window or from mutable future-updated candles.
 if(now-due>90000)return {state:'MISSED_REALTIME_OUTCOME_WINDOW',
  horizonMinutes:record.horizonMinutes,notBackfilled:true};
 if(row.status!=='OPEN'||(Number.isFinite(closed)&&closed<=now))
  return {state:'ACTUAL_CLOSED_AFTER_HORIZON_BEFORE_OBSERVER',
   horizonMinutes:record.horizonMinutes,notBackfilled:true};
 const latest=newest(quotes,now);
 if(!latest||latest.sampledAt<due)return {state:'NO_FRESH_ASOF_HORIZON_MARK',
  horizonMinutes:record.horizonMinutes,noPredictionScore:true};
 const mark=evaluate(row,quotes,now,feeReserve);
 if(mark.state==='INVALID_VERIFIED_ENTRY'||mark.state==='NO_FRESH_BROKER_NATIVE_QUOTE')
  return {state:'UNVERIFIED_HORIZON_MARK',horizonMinutes:record.horizonMinutes};
 return {state:'REALTIME_BROKER_NATIVE_PRICE_MARK_ONLY',
  horizonMinutes:record.horizonMinutes,
  quoteAt:new Date(latest.sampledAt).toISOString(),
  sampledSecondsAfterForecastHorizon:rnd((latest.sampledAt-due)/1000,1),
  markIsNotExactHorizonFill:true,
  theoreticalGrossUsd:mark.grossMarketMarkEstimateUsd,
  theoreticalNetAfterEstimatedFeeUsd:mark.hypotheticalNetAfterFeeEstimateUsd,
  quoteOnlyAboveEstimatedCost:mark.hypotheticalNetAfterFeeEstimateUsd===null?null:
   mark.hypotheticalNetAfterFeeEstimateUsd>0,
  riskAtHorizon:mark.state,
  noBrokerFillClaim:true,noGuaranteedRecoveryClaim:true};
}
module.exports={ARTIFACT,EARLY_CAUTION_ARTIFACT,HORIZONS,CHECKPOINTS,INSTRUMENTS,ROUTES,quote,newest,evaluate,
 earlyProfitFade,asOfCheckpoint,labelMature};
