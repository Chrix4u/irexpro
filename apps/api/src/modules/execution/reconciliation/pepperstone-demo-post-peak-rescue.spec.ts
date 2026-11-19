import {
 evaluatePepperstoneDemoPostPeakAdverseRescue as assess,
 PEPPERSTONE_DEMO_POST_PEAK_ADVERSE_RESCUE_ARTIFACT,
 type PepperstoneDemoPostPeakRescueInput,
} from './pepperstone-demo-post-peak-rescue';
const base: PepperstoneDemoPostPeakRescueInput={
 enabled:true,brokerId:'pepperstone-ctrader',
 accountType:'DEMO',accountCurrency:'USD',
 ownerUserId:'owner',userId:'owner',
 strategyRoute:'CONFIRMED_REVERSAL',isM1Strategy:true,
 tradeInstrument:'EURUSD',brokerInstrument:'EURUSD',
 tradeDirection:'SELL',brokerDirection:'SELL',
 tradeLots:1.78,brokerLots:1.78,
 entryPrice:1.09927,currentPrice:1.09932,
 originalStop:1.09983,brokerStop:1.09983,
 originalTakeProfit:1.09853,brokerTakeProfit:1.09853,
 initialRiskPnl:89,peakBrokerNetPnl:30.26,
 currentBrokerNetPnl:-5.34,
 previousObservationCount:175,elapsedMinutes:17.78,
 m1:{completedBars:3,adverseBars:3,liveQuoteBars:2,
  consecutiveLiveQuoteBars:2,alignedLatestBodyPressure:-0.63157,
  alignedMomentum3:-0.60975,latestAgeSeconds:11,
  latestLiveSpreadPrice:0.00002},
};
describe('owner DEMO Confirmed Reversal post-peak loss-gap rescue',()=>{
 it('recognizes the exact 2026-11-19 EURUSD failure before the -$113.92 final close',()=>{
  const r=assess(base);
  expect(r).toMatchObject({
    artifact:PEPPERSTONE_DEMO_POST_PEAK_ADVERSE_RESCUE_ARTIFACT,
    shouldClose:true,reason:'POST_PEAK_ADVERSE_LOSS_RESCUE',
    noNewOrders:true,noBrokerAmendment:true,modifiesLive:false,
  });
  expect(r.peakR).toBeCloseTo(30.26/89);
  expect(r.currentR).toBeCloseTo(-5.34/89);
 });
 it.each([
  {enabled:false},{brokerId:'ctrader'},{accountType:'LIVE'},
  {accountCurrency:'EUR'},{ownerUserId:null},
  {ownerUserId:'another'},{userId:'another'},
  {strategyRoute:'EARLY_TRANSITION'},
  {strategyRoute:'TREND_CONTINUATION'},
  {isM1Strategy:false},
 ])('cannot extend this intervention to any other route, owner or LIVE: %j',patch=>{
  expect(assess({...base,...patch}).shouldClose).toBe(false);
 });
 it.each([
  {tradeInstrument:'GBPUSD'},{brokerInstrument:'GBPUSD'},
  {brokerDirection:'BUY'},{tradeLots:2.00},
  {brokerLots:1.5},{entryPrice:null},
  {currentPrice:1.09987},{currentPrice:1.09920},
  {originalStop:null},{brokerStop:1.09982},
  {originalTakeProfit:1.09940},{brokerTakeProfit:1.09860},
  {initialRiskPnl:null},{initialRiskPnl:0},
 ])('refuses mismatched broker identity and unverified stop geometry %j',patch=>{
  expect(assess({...base,...patch}).shouldClose).toBe(false);
 });
 it.each([
  {peakBrokerNetPnl:26.69}, // <0.30R
  {peakBrokerNetPnl:44.50}, // >=0.50R; existing net lock owns
  {currentBrokerNetPnl:0.01}, // still a winner
  {currentBrokerNetPnl:-63.00}, // already beyond safety window
  {previousObservationCount:5},
  {elapsedMinutes:1},
 ])('does not close unqualified peaks or first noisy pullbacks %j',patch=>{
  expect(assess({...base,...patch}).shouldClose).toBe(false);
 });
 it.each([
  {completedBars:2},{completedBars:Number.NaN},
  {adverseBars:2},{adverseBars:Number.NaN},
  {liveQuoteBars:1},{liveQuoteBars:Number.NaN},
  {consecutiveLiveQuoteBars:1},{consecutiveLiveQuoteBars:Number.NaN},
  {alignedLatestBodyPressure:-0.2},
  {alignedMomentum3:-0.11},
  {latestAgeSeconds:76},{latestAgeSeconds:-1},
  {latestLiveSpreadPrice:null},{latestLiveSpreadPrice:0.001},
 ])('requires independently quoted fresh multi-candle adverse proof %j',patch=>{
  expect(assess({...base,m1:{...base.m1!,...patch}}).shouldClose).toBe(false);
 });
 it('does not chase a recovered 0.26R peak or close a winner',()=>{
  const recovered=assess({...base,initialRiskPnl:31.26230953,
   peakBrokerNetPnl:8.26,currentBrokerNetPnl:-12.38});
  expect(recovered.shouldClose).toBe(false);
  const winning=assess({...base,currentBrokerNetPnl:8});
  expect(winning.shouldClose).toBe(false);
 });
});
