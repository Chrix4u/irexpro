const test = require('node:test');
const assert = require('node:assert/strict');
const {
  observedMark, isPositiveObservedMark,
  quickProfitFirstTouch, summarize,
} = require('./audit-independent-m1-profit-window.cjs');

test('does not invent a price from a historical zero-spread close', () => {
  const minute={
    bucket_time:'2026-11-12T17:02:00Z',
    bid_close:'1.10566',ask_close:'1.10566',
    last_positive_bid:null,last_positive_ask:null,last_positive_sample_at:null,
  };
  assert.equal(isPositiveObservedMark(minute),false);
  assert.equal(observedMark(minute),null);
});

test('uses positive same-minute broker tick rather than fictitious close', () => {
  const minute={
    bucket_time:'2026-11-12T17:02:00Z',
    bid_close:'1.10566',ask_close:'1.10566',
    last_positive_bid:'1.10563',last_positive_ask:'1.10564',
    last_positive_sample_at:'2026-11-12T17:02:30Z',
  };
  const mark=observedMark(minute);
  assert.equal(mark.source,'POSITIVE_INTRAMINUTE');
  assert.equal(mark.bid,1.10563);
  assert.equal(mark.ask,1.10564);
});

test('rejects stale positive ticks from a different minute', () => {
  assert.equal(observedMark({
    bucket_time:'2026-11-12T17:02:00Z',
    bid_close:1.10566,ask_close:1.10566,
    last_positive_bid:1.10563,last_positive_ask:1.10564,
    last_positive_sample_at:'2026-11-12T17:01:58Z',
  }),null);
});

test('5:02 hypothetical SELL can touch 2pip profit only after surviving adverse move', () => {
  const result=quickProfitFirstTouch({
    direction:'SELL',entry:1.10563,stop:1.106135,
    capturePips:2,quoteSpreadPips:0.1,
    bars:[
      {high:'1.10579',low:'1.10560'},
      {high:'1.10586',low:'1.10568'},
      {high:'1.10592',low:'1.10577'},
      {high:'1.10592',low:'1.10574'},
      {high:'1.10576',low:'1.10545'},
      {high:'1.10552',low:'1.10538'},
    ],
  });
  assert.equal(result.status,'QUICK_TP_PROXY');
  assert.ok(result.netPips > 0);
});

test('stop-loss wins whenever stop and target are inside the same minute', () => {
  const result=quickProfitFirstTouch({
    direction:'SELL',entry:1.10563,stop:1.106135,
    capturePips:2,quoteSpreadPips:0.2,
    bars:[{high:1.10625,low:1.10530}],
  });
  assert.equal(result.status,'STOP_FIRST');
  assert.ok(result.netPips < -5);
});

test('summaries do not count missing values as successes', () => {
  assert.deepEqual(summarize([1,-2,NaN]),{
    evaluated:2,netPips:-1,profitable:1,winRate:0.5,profitFactor:0.5,
  });
});
