const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eligibleLegacyM1, closeQuickProfitPolicy, passivePullbackCounterfactual, fullyObservedQuotePath, HORIZONS, MATURE_LAG_MINUTES,
} = require('./audit-independent-m1-profit-window.cjs');

const old = {
  instrument:'EURUSD',direction:'SELL',route:'M1_TREND_CONTINUATION',
  entry:'1.105635',sl:'1.106135',tp:'1.104835',
  m1_route_eligible:'true',m1_paper_eligible:'true',
  spread_valid:'true',event_risk:'CLEAR',
  reliability_eligible:'true',planb_disagreed:'true',
};
test('legacy reconstruction uses the as-of M1 candidate, not subsequent Plan B result',()=>{
  assert.equal(eligibleLegacyM1(old),true);
  assert.equal(eligibleLegacyM1({...old,planb_disagreed:'false'}),true);
});
test('legacy reconstruction rejects stale/invalid/spread or unavailable-route candidates',()=>{
  assert.equal(eligibleLegacyM1({...old,spread_valid:'false'}),false);
  assert.equal(eligibleLegacyM1({...old,event_risk:'HIGH_IMPACT_BLOCK'}),false);
  assert.equal(eligibleLegacyM1({...old,m1_route_eligible:'false'}),false);
  assert.equal(eligibleLegacyM1({...old,sl:'1.1045'}),false);
});
test('quick profit policy closes at mark if neither stop nor TP was touched',()=>{
  assert.equal(closeQuickProfitPolicy({status:'NO_FIRST_TOUCH'},-2.7),-2.7);
  assert.equal(closeQuickProfitPolicy({status:'NO_FIRST_TOUCH'},1.2),1.2);
});
test('quick profit policy records stop-first loss instead of hindsight profit',()=>{
  assert.equal(closeQuickProfitPolicy({status:'STOP_FIRST',netPips:-6.1},4.9),-6.1);
  assert.equal(closeQuickProfitPolicy({status:'QUICK_TP_PROXY',netPips:0.9},-2.1),0.9);
  assert.equal(closeQuickProfitPolicy({status:'DATA_GAP'},2.7),null);
});


test('one-pip SELL passive pullback can fill after signal, then exit after decline',()=>{
  const r=passivePullbackCounterfactual({
    direction:'SELL',referenceEntry:1.1055,originalStopDistancePips:5,
    quoteSpreadPips:0.1,capturePips:2,entryPullbackPips:1,
    bars:[
      {high:1.10567,low:1.10548},
      {high:1.10579,low:1.1056},
      {high:1.10586,low:1.10568},
      {high:1.10592,low:1.10577},
      {high:1.10592,low:1.10574},
      {high:1.10576,low:1.10545},
      {high:1.10552,low:1.10538},
    ],
  });
  assert.equal(r.state,'TAKE_PROFIT_PROXY');
  assert.equal(r.fillMinute,0);
  assert.ok(r.netPips>0);
});

test('pullback always assumes stop before TP in the filled minute',()=>{
  const r=passivePullbackCounterfactual({
    direction:'SELL',referenceEntry:1.1055,originalStopDistancePips:5,
    quoteSpreadPips:0.1,
    bars:[{high:1.1063,low:1.1053}],
  });
  assert.equal(r.state,'STOP_FIRST_PROXY');
  assert.ok(r.netPips<-5);
});

test('passive entry that never receives a price retracement stays unfilled',()=>{
  const r=passivePullbackCounterfactual({
    direction:'SELL',referenceEntry:1.1055,originalStopDistancePips:5,
    quoteSpreadPips:0.1,
    bars:[{high:1.10554,low:1.10531},{high:1.10535,low:1.10505},
      {high:1.10524,low:1.10495}],
  });
  assert.equal(r.state,'NOT_FILLED');
  assert.equal(r.netPips,null);
});

test('timed exit is priced at observed broker ask, not a future candle low',()=>{
  const r=passivePullbackCounterfactual({
    direction:'SELL',referenceEntry:1.1055,originalStopDistancePips:5,
    quoteSpreadPips:0.1,
    bars:[
      {bucket_time:'2026-11-12T17:01:00Z',high:1.10567,low:1.10548,
       bid_close:1.10552,ask_close:1.10553},
      {bucket_time:'2026-11-12T17:02:00Z',high:1.10568,low:1.10550,
       bid_close:1.10555,ask_close:1.10556},
    ],
  });
  assert.equal(r.state,'TIMED_EXIT_PROXY');
  assert.ok(r.netPips < 0);
});


test('two-point directional evidence survives a missing middle quote, but stop path does not',()=>{
 const good={bucket_time:'2026-11-12T17:02:00Z',bid_close:1.1055,ask_close:1.10551};
 const missing={bucket_time:'2026-11-12T17:03:00Z',bid_close:1.1056,ask_close:1.1056};
 assert.equal(fullyObservedQuotePath([good,missing,good],3),false);
 assert.equal(fullyObservedQuotePath([good,good,good],3),true);
 assert.equal(fullyObservedQuotePath([good,good],3),false);
});


test('prospective evaluation cannot mature before the longest exit horizon plus 2-minute buffer',()=>{
  assert.deepEqual(HORIZONS,[3,5,6,7,10]);
  assert.equal(MATURE_LAG_MINUTES,12);
  assert.ok(MATURE_LAG_MINUTES > Math.max(...HORIZONS));
});
