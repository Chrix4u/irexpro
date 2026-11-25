'use strict';
/**
 * READ-ONLY owner Pepperstone DEMO sub-minute quote shadow.
 * Only *forming*, broker-native, positive-spread bid/ask observations sampled
 * after broker fill; every event is observation, not an executable exit.
 */
const ARTIFACT='irexpro-owner-demo-subminute-native-quote-pressure-v1';
const n=x=>x===null||x===undefined||x===''?null:Number.isFinite(+x)?+x:null;
const ms=x=>x==null?NaN:new Date(x).getTime();
const rnd=(x,d=3)=>x==null||!Number.isFinite(x)?null:+x.toFixed(d);
const pip=x=>x.endsWith('JPY')?.01:.0001;
function freshFormingNativeQuote(q,now,openedAt) {
 const start=ms(q?.bucket_time),sample=ms(q?.last_positive_sample_at),
  created=ms(q?.created_at),updated=ms(q?.updated_at),opened=ms(openedAt);
 const bid=n(q?.last_positive_bid),ask=n(q?.last_positive_ask);
 if(q?.timeframe!=='M1'||q?.source!=='ctrader-broker-native'||
  !Number.isFinite(start)||!Number.isFinite(sample)||
  !Number.isFinite(created)||!Number.isFinite(updated)||
  !Number.isFinite(opened)||opened>now||
  start>now||start+60000<=now||sample<start||sample>=start+60000||
  created>now||created<start||updated<sample||updated>now||
  sample<opened||sample>now||now-sample>10000||
  !(n(q?.sample_count)>=2)||!(n(q?.positive_quote_sample_count)>=2)||
  !(bid>0&&ask>bid))return null;
 const spread=(ask-bid)/pip(q.instrument);
 if(!(spread>0&&spread<=3))return null;
 return {at:new Date(sample).toISOString(),bid,ask,
  bucketStart:new Date(start).toISOString(),spreadPips:rnd(spread,3),
  marketData:'BROKER_NATIVE_POSITIVE_SPREAD_FORMING_M1',
  finalizedCandle:false,asOfAtCapture:true,brokerFillEvidence:false};
}
function evaluateRapid(row,quote,prior,feeUsd,now){
 const immutable={
  artifact:ARTIFACT,observedAt:new Date(now).toISOString(),
  researchOnly:true,executionAuthority:'NONE',noBrokerOrders:true,
  noStopAmendments:true,noProfitProtectionChanges:true,
  noPredictionProbability:true,brokerExecutableCloseUnverified:true,
  subMinuteIntrabarSequenceNotGuaranteed:true,
 };
 const opened=ms(row.opened_at),qt=ms(quote?.at),
  fill=n(row.fill_price),stop=n(row.stop_loss),
  lots=n(row.lot_size),fee=n(feeUsd),
  sign=row.direction==='BUY'?1:row.direction==='SELL'?-1:0;
 if(!quote||!(lots>0)||!(fill>0&&stop>0)||!sign||
  !(sign*(fill-stop)>0)||!Number.isFinite(opened)||
  !Number.isFinite(qt)||qt<opened||qt>now||
  now-opened>60000||now-opened<0)
  return {...immutable,status:'UNVERIFIED_FRESH_OPEN_BROKER_QUOTE'};
 const side=sign===1?quote.bid:quote.ask,
  gross=sign*(side-fill)*lots*100000/(row.instrument.startsWith('USD')?side:1),
  net=fee>0?gross-fee:null,
  stopHeadroomR=sign*(side-stop)/Math.abs(fill-stop),
  risk= Math.abs(fill-stop),
  priorTime=ms(prior?.quoteSampledAt),
  priorMark=n(prior?.quoteSidePrice),
  lagSeconds=(qt-priorTime)/1000,
  recentDeltaR=priorMark!==null&&Number.isFinite(lagSeconds)&&
   lagSeconds>=5&&lagSeconds<=35?rnd(sign*(side-priorMark)/risk,4):null,
  hadPositiveNet=fee>0&&net>0&&n(prior?.estimatedNetAfterFeeUsd)>0,
  nearStop=recentDeltaR!==null&&stopHeadroomR<.35&&recentDeltaR<-.045,
  positiveFade=recentDeltaR!==null&&recentDeltaR<=-.07&&hadPositiveNet&&
   n(prior.estimatedNetAfterFeeUsd)>net;
 let state='NO_VALID_SUBMINUTE_DIRECTION_COMPARISON';
 if(recentDeltaR!==null)state='NO_STRONG_SUBMINUTE_WARNING';
 if(positiveFade)state='FAST_STILL_POSITIVE_NET_FADE_WATCH';
 else if(nearStop)state='FAST_APPROACHING_ORIGINAL_STOP_WATCH';
 return {...immutable,status:'VALID_ASOF_SUBMINUTE_OBSERVATION',
  state,quoteSampledAt:quote.at,quoteSidePrice:side,
  spreadPips:quote.spreadPips,
  secondsSinceOpened:rnd((qt-opened)/1000,2),
  initialStopHeadroomR:rnd(stopHeadroomR,4),
  estimatedGrossMarkUsd:rnd(gross,2),
  estimatedNetAfterFeeUsd:rnd(net,2),
  feeReserveUsd:fee>0?fee:null,
  feeEvidencePresent:fee>0,
  recentDeltaR,
  priorIntervalSeconds:Number.isFinite(lagSeconds)?rnd(lagSeconds,1):null,
  strongSubminuteWarning:nearStop||positiveFade,
  observedStillNetPositiveFade:positiveFade,
  estimatedNetRemainingAtCautionUsd:positiveFade?rnd(net,2):null,
  quoteNotBrokerExecutionPrice:true,
  preCloseDecisionSnapshotOnly:true,
 };
}
function forwardSummary(trades,rapidActivatedAt=null) {
 const activated=ms(rapidActivatedAt);
 const eligible=Number.isFinite(activated)?trades.filter(t=>
  Number.isFinite(ms(t.openedAt))&&ms(t.openedAt)>=activated):trades;
 const rows=eligible.flatMap(t=>(t.rapidSamples||[]).map(s=>({t,s})));
 const seen=eligible.filter(t=>(t.rapidSamples||[]).length>0);
 const warnings=rows.filter(x=>x.s.strongSubminuteWarning===true);
 const cautioned=[...new Set(warnings.map(x=>x.t.tradeId))];
 const flagged=eligible.filter(t=>cautioned.includes(t.tradeId));
 const closed=eligible.filter(t=>t.settled&&Number.isFinite(ms(t.settled.closedAt)));
 const rapidCloses=closed.filter(t=>ms(t.settled.closedAt)-ms(t.openedAt)<60000);
 const flaggedSettled=flagged.filter(t=>t.settled);
 return {artifact:ARTIFACT,readOnly:true,brokerOrders:0,
  oldOneMinuteStrategyUnchanged:true,
  openTradesWithRapidQuotes:seen.length,observations:rows.length,
  strongWarningObservations:warnings.length,
  flaggedDistinctTrades:flagged.length,
  flaggedSettledTrades:flaggedSettled.length,
  flaggedSettledWinners:flaggedSettled.filter(t=>t.settled.netUsd>0).length,
  flaggedSettledLosers:flaggedSettled.filter(t=>t.settled.netUsd<0).length,
  postEnrolmentClosedWithin60s:rapidCloses.length,
  rapidClosesWithoutValidOpenQuote:rapidCloses.filter(t=>(t.rapidSamples||[]).length===0).length,
  rapidCloseBrokerNetUsd:rnd(rapidCloses.reduce((sum,t)=>sum+t.settled.netUsd,0),2),
  stillProfitableFadingWatchCount:rows.filter(x=>x.s.observedStillNetPositiveFade).length,
  noHypotheticalSavedMoneyClaim:true,
  modelCalibrated:false,autoExitDisabled:true,requiresProspectiveValidation:true};
}
module.exports={ARTIFACT,freshFormingNativeQuote,evaluateRapid,forwardSummary};
