'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarize,START}=require('./audit-pepperstone-continuous-evidence.cjs');
const at=(min)=>'2026-11-17T02:'+String(min).padStart(2,'0')+':00.000Z';
const base={
 instrument:'USDJPY',direction:'SELL',route:'EARLY_TRANSITION',status:'CLOSED',
 openedAt:at(10),closedAt:at(18),lots:'3.18',
 grossRealized:'49.86',commission:'-19.08',swap:'0',
 closeReason:'PROFIT_PROTECTION',peakGross:'86.20',givebackGross:'36.34',
 pathObservedAt:at(17),observations:80,
 advisory:'true',continuous:'true',pullback:'false'
};
const win={...base};
const loss={...base,route:'CONFIRMED_REVERSAL',openedAt:'2026-11-17T00:44:13Z',closedAt:'2026-11-17T00:53:20Z',grossRealized:'-101.73',commission:'-19.08',closeReason:'BROKER_CLOSE',continuous:'false',peakGross:'72.20',givebackGross:'173.93'};
const open={...base,route:'CONFIRMED_REVERSAL',status:'OPEN',openedAt:at(14),closedAt:null,
 grossRealized:null,commission:null,swap:null,closeReason:null,peakGross:'29.39',
 givebackGross:'29.98',pathObservedAt:at(20)};
const options={from:START,until:'2026-11-17T02:22:00.000Z',now:new Date('2026-11-17T02:20:45Z')};
test('uses independent net broker closes instead of scanner count',()=>{
 const r=summarize([loss,win,open],[{route:'CONFIRMED_REVERSAL',reason:'ELIGIBLE',scans:80}],options);
 assert.equal(r.summary.independentOrders,3);
 assert.equal(r.summary.closed,2);
 assert.equal(r.summary.open,1);
 assert.equal(r.summary.realizedNet,-90.03);
 assert.equal(r.summary.continuousRealizedNet,30.78);
 assert.equal(r.summary.maxClosedEquityDrawdown,120.81);
 assert.equal(r.summary.openPositionsWithFreshRecordedMarks,1);
 assert.equal(r.scannerScanCountsNotIndependentTrades['CONFIRMED_REVERSAL / ELIGIBLE'],80);
 assert.equal(r.positionLedger.find(x=>x.status==='OPEN').latestObservedGross,-0.59);
 assert.equal(r.positionLedger.find(x=>x.status==='OPEN').realizedNet,null);
 assert.equal(r.byRoute.find(x=>x.cohort==='CONTINUOUS').protectedProfitCloses,1);
});
test('does not turn missing commission into a false after-fee winner',()=>{
 const bad={...base,commission:null};
 const r=summarize([bad],[],options);
 assert.equal(r.summary.completeClosedAfterFees,0);
 assert.equal(r.summary.incompleteClosedFees,1);
 assert.equal(r.positionLedger[0].realizedNet,null);
 assert.equal(r.summary.realizedNet,0);
});
test('retains negative commissions and computes profit factor when losses exist',()=>{
 const r=summarize([{...base,commission:'-19.08'},
  {...base,openedAt:at(11),closedAt:at(19),grossRealized:'-50',commission:'-5'}],[],options);
 const b=r.byRoute[0];
 assert.equal(b.netTotal,-24.22);
 assert.equal(b.profitFactor,0.56);
 assert.equal(b.winRate,50);
 assert.equal(b.losses,1);
});
test('refuses out-of-window and unknown strategy rows',()=>{
 assert.throws(()=>summarize([{...base,openedAt:'2026-11-15T00:00:00Z'}],[],options),/OUT_OF_WINDOW/);
 assert.throws(()=>summarize([{...base,route:'UNKNOWN'}],[],options),/OUT_OF_SCOPE/);
});
test('open mark older than 90 seconds is flagged stale, not current',()=>{
 const r=summarize([{...open,pathObservedAt:at(15)}],[],options);
 assert.equal(r.positionLedger[0].latestObservationFresh,false);
 assert.equal(r.summary.openPositionsWithFreshRecordedMarks,0);
});
