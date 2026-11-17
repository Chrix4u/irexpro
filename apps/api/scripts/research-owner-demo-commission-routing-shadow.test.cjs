'use strict';
const t=require('node:test'),a=require('node:assert/strict');
const {evaluate,validateRow}=require('./research-owner-demo-commission-routing-shadow.cjs');
const con='demo-account-research-only';
const stamp=(day,hour)=>new Date(Date.UTC(2026,10,day,hour)).toISOString();
function row(day,hour,route='EARLY_TRANSITION',instrument='EURUSD',other={}) {
 const opened=Date.UTC(2026,10,day,hour),closed=opened+30*60000;
 return {
   route,instrument,accountCurrency:'USD',brokerConnectionId:con,
   openedAt:new Date(opened).toISOString(),closedAt:new Date(closed).toISOString(),
   allocationCreatedAt:new Date(opened-1000).toISOString(),
   initialCashRisk:'100',lots:'1',grossPnl:'12',commission:'-3',swap:'0',
   preExistingExpectedNetR:'.12',...other,
 };
}
const earlier=()=>Array.from({length:7},(_,i)=>row(12,8+i,'EARLY_TRANSITION','EURUSD'));
t('causal P90 fee uses only already closed history for evaluation',()=>{
 const rows=[...earlier(),row(13,7),row(13,9,'TREND_CONTINUATION','EURUSD',{grossPnl:'-15'})];
 const out=evaluate(rows,{from:stamp(13,0),asOf:stamp(14,0),brokerConnectionId:con});
 a.equal(out.sampleClosedTrades,2);
 a.equal(out.total.usableCausalCommissionEstimate,2);
 a.equal(out.total.commissionForecastMeanR,.03);
 a.equal(out.total.observedCommissionMeanR,.03);
 a.equal(out.total.predictedAfterCommissionMeanR,.09);
 a.equal(out.total.exploratoryPredictedBelow008R,0);
 a.equal(out.total.exploratoryPredictedAtOrAbove008R,2);
 a.equal(out.total.keptHistoricalNetCashUSD,-9);
 a.equal(out.livePromotionAllowed,false);
});
t('no future closed fee observation can qualify prior history',()=>{
 const rows=Array.from({length:5},(_,i)=>row(13,8,'EARLY_TRANSITION','EURUSD',
  {openedAt:stamp(13,8),closedAt:stamp(13,11),commission:'-100',lotSize:'1'}));
 rows.push(row(13,9));
 const out=evaluate(rows,{from:stamp(13,0),asOf:stamp(14,0),brokerConnectionId:con});
 a.equal(out.total.usableCausalCommissionEstimate,0);
 a.equal(out.total.notEnoughPriorClosedSameInstrument,6);
});
t('forecast missing does not cause a fabricated shadow veto',()=>{
 const out=evaluate([...earlier(),row(13,11,'CONFIRMED_REVERSAL','EURUSD',
  {preExistingExpectedNetR:null})],{
   from:stamp(13,0),asOf:stamp(14,0),brokerConnectionId:con});
 a.equal(out.total.usableCausalCommissionEstimate,0);
 a.equal(out.total.missingPreEntryModelForecast,1);
});
t('a low after-fee estimate marks research flag only, not a trade gate',()=>{
 const x=row(13,11,'EARLY_TRANSITION','EURUSD',{
   preExistingExpectedNetR:'.05',commission:'-3',grossPnl:'10'});
 const out=evaluate([...earlier(),x],{
   from:stamp(13,0),asOf:stamp(14,0),brokerConnectionId:con});
 a.equal(out.total.exploratoryPredictedBelow008R,1);
 a.equal(out.total.flaggedHistoricalNetCashUSD,7);
 a.equal(out.total.flaggedHistoricalNetWinners,1);
 a.equal(out.modelPromotionAllowed,false);
 a.equal(out.brokerOrderAuthority,false);
});
t('rejects mixed account and invalid allocation authority',()=>{
 const all=[...earlier(),row(13,8,'EARLY_TRANSITION','EURUSD',
  {brokerConnectionId:'other'})];
 a.throws(()=>evaluate(all,{from:stamp(13,0),asOf:stamp(14,0),
   brokerConnectionId:con}),/MIXED_BROKER_ACCOUNT/);
 const x=row(13,8,'EARLY_TRANSITION','EURUSD',
  {allocationCreatedAt:stamp(13,10)});
 a.equal(validateRow(x),false);
});
t('ineligible rows are excluded and never treated as a loss',()=>{
 const out=evaluate([...earlier(),row(13,9,'EARLY_TRANSITION','EURUSD',
    {initialCashRisk:null})],{
     from:stamp(13,0),asOf:stamp(14,0),brokerConnectionId:con});
 a.equal(out.sampleClosedTrades,0);
 a.equal(out.excludedIncompleteOrUnclassifiedRecentTrades,1);
});
t('no order code or live broker authority',()=>{
 const source=require('node:fs').readFileSync(__filename.replace('.test.cjs','.cjs'),'utf8');
 a.match(source,/researchOnly:true/);
 a.match(source,/brokerOrderAuthority:false/);
 a.doesNotMatch(source,/\b(?:placeOrder|executeTrade|closePosition|UPDATE\s+trading)\s*\(/);
});
