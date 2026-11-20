'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('./owner-demo-recovery-risk-shadow.cjs');
const watcher=require('./watch-owner-demo-recovery-risk-shadow.cjs');
const time=Date.parse('2026-11-20T16:05:10.000Z');
const iso=x=>new Date(x).toISOString();
const row=(extra={})=>({
 trade_id:'6ed0ae55-4e31-4d22-9074-55c97800397a',
 broker_connection_id:'dde65a12-70e1-4d6b-97bb-5af2384d8714',
 route:'CONFIRMED_REVERSAL',instrument:'EURUSD',direction:'BUY',
 status:'OPEN',opened_at:iso(time-5*60000),closed_at:null,
 fill_price:'1.10020',stop_loss:'1.09970',lot_size:'2',
 max_favorable_pnl:'60',profit_giveback:'50',
 path_last_observed_at:iso(time-2000),
 sizing_inputs:{demoExecutionRiskEnvelope:{historicalFeePerLot:'6'}},
 realised_pnl:null,commission:null,swap:null,close_reason:null,
 ...extra
});
function raw(start,bid,extra={}){
 const t=Date.parse(start);
 return {instrument:'EURUSD',timeframe:'M1',source:'ctrader-broker-native',
  bucket_time:iso(t),created_at:iso(t+1000),updated_at:iso(t+60500),
  last_positive_sample_at:iso(t+55000),
  last_positive_bid:String(bid),
  last_positive_ask:String(bid+.00002),
  positive_quote_sample_count:12,sample_count:20,...extra};
}
function quotes(at=time){
 return [
  raw('2026-11-20T16:04:00Z',1.10005),
  raw('2026-11-20T16:03:00Z',1.10009),
  raw('2026-11-20T16:01:00Z',1.10013),
  raw('2026-11-20T15:59:00Z',1.10020),
 ].map(q=>model.quote(q,at)).filter(Boolean);
}
const marker={activatedAt:'2026-11-20T16:00:00.000Z',artifact:model.ARTIFACT};
test('completed source quote must have positive bid/ask, last-minute sampling and no future update',()=>{
 const q=raw('2026-11-20T16:04:00Z',1.10005);
 assert.equal(model.quote(q,time).asOfVerified,true);
 assert.equal(model.quote(q,Date.parse('2026-11-20T16:04:50Z')),null);
 assert.equal(model.quote({...q,positive_quote_sample_count:1},time),null);
 assert.equal(model.quote({...q,last_positive_ask:'1.10005'},time),null);
 assert.equal(model.quote({...q,updated_at:iso(time+60000)},time),null);
 assert.equal(model.quote({...q,last_positive_sample_at:iso(time+1000)},time),null);
 assert.equal(model.quote({...q,source:'twelve-data'},time),null);
});
test('uses ORIGINAL filled stop, fresh sampled counter-momentum and actual positive peak only as-of',()=>{
 const q=quotes();
 assert.equal(q.length,4);
 const v=model.evaluate(row(),q,time,12);
 assert.equal(v.state,'POSITIVE_PEAK_GIVEBACK_WITH_COUNTER_MOMENTUM');
 assert.equal(v.calibratedProbability,null);
 assert.ok(v.alignedLast1mR<0);
 assert.ok(v.alignedLast3mR<0);
 assert.equal(v.recordedPeakAboveFeeReserve,true);
 assert.ok(v.hypotheticalNetAfterFeeEstimateUsd<0);
 assert.equal(v.noProfitProtectionChanges,true);
 assert.equal(v.horizons[5].predictedPriceRecoveryProbability,null);
 assert.equal(v.horizons[20].noAutomaticClose,true);
});
test('cannot claim signal when only stale, missing or zero-spread quotes exist',()=>{
 assert.equal(model.evaluate(row(),[],time,12).state,'NO_FRESH_BROKER_NATIVE_QUOTE');
 assert.equal(model.evaluate(row(),quotes().filter(q=>q.completedAt<time-85000),time,12).state,
  'NO_FRESH_BROKER_NATIVE_QUOTE');
 assert.equal(model.evaluate(row({stop_loss:'1.10100'}),quotes(),time,12).state,
  'INVALID_VERIFIED_ENTRY');
});
test('directionally strong one-minute recovery does not trigger counter-momentum warning',()=>{
 const q=quotes();
 q[0].bid=1.10020;q[0].ask=1.10022;
 // quote array is newest-first; modify ONLY the newest as-of price.
 const v=model.evaluate(row(),q,time,12);
 assert.equal(v.state,'NO_STRONG_REVERSAL_WARNING');
});
test('checkpoint eligibility uses OPEN-only actual time; no historical backfill or overlapping buckets',()=>{
 assert.equal(model.asOfCheckpoint(row(),row().opened_at,time),5);
 assert.equal(model.asOfCheckpoint(row(),row().opened_at,time+35000),null);
 assert.equal(model.asOfCheckpoint(row({status:'CLOSED'}),row().opened_at,time),null);
 assert.equal(model.asOfCheckpoint(row(),row().opened_at,time-7*60000),null);
 assert.equal(model.asOfCheckpoint(row(),row().opened_at,time+60000),6);
});
test('exact owner-only DEMO queries and no writes or brokerage dependencies',()=>{
 for(const segment of [
  't.user_id=$1 AND t.broker_connection_id=$2 AND b.user_id=$1',
  "b.broker_id='pepperstone-ctrader'",
  "b.account_type='DEMO'", "b.account_currency='USD'",
  "t.account_currency='USD'", "ti.stop_loss",
 ])assert.ok(watcher.TRADES_SQL.includes(segment),segment);
 assert.match(watcher.QUOTES_SQL,/connection_id=\$1/);
 assert.match(watcher.QUOTES_SQL,/source='ctrader-broker-native'/);
 assert.doesNotMatch(watcher.TRADES_SQL+watcher.QUOTES_SQL,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
 assert.equal(watcher.feeReserve(row()),12);
 assert.equal(watcher.feeReserve(row({sizing_inputs:{}})),null);
});
test('no post-close first-time enrollment and no retroactive enabling on unobserved entries',()=>{
 const early={...row(),opened_at:iso(time-40*60000)};
 assert.equal(watcher.enroll(early,marker,time),null);
 assert.equal(watcher.enroll(row({status:'CLOSED'}),marker,time),null);
 const nowEntry={...row(),opened_at:iso(time-1000)};
 assert.ok(watcher.enroll(nowEntry,marker,time));
 assert.equal(watcher.enroll({...nowEntry,opened_at:iso(time+1000)},marker,time),null);
});
test('one-time frozen quote signal remains intact when broker later closes at loss',()=>{
 const open=watcher.enroll(row({opened_at:iso(time-15000)}),marker,time);
 assert.ok(open);
 // Artificially place entry in prior minute to allow 5-min snapshot.
 const previous={...open,openedAt:iso(time-5*60000)};
 const scored=watcher.plan(row(),previous,marker,time,quotes());
 assert.ok(scored.events.some(e=>e.stage==='OPEN_REALTIME_RISK_SNAPSHOT'));
 assert.equal(scored.entry.snapshots[5].signal.state,
  'POSITIVE_PEAK_GIVEBACK_WITH_COUNTER_MOMENTUM');
 const after=watcher.plan(row({status:'CLOSED',
  closed_at:iso(time+3*60000),realised_pnl:'-180',commission:'-12',swap:'0',
  close_reason:'BROKER_CLOSE'}),scored.entry,marker,time+6*60000,[]);
 assert.equal(after.entry.snapshots[5].signal.state,
  'POSITIVE_PEAK_GIVEBACK_WITH_COUNTER_MOMENTUM');
 assert.equal(after.entry.settled.netUsd,-192);
 assert.equal(after.entry.snapshots[5].futures[5].actual.state,
  'ACTUAL_POSITION_CLOSED_BEFORE_HORIZON');
 assert.equal(after.entry.snapshots[5].futures[5].actual.actualBrokerNetUsd,-192);
 const s=watcher.summary({trades:{test:after.entry}},marker,time+6*60000);
 assert.equal(s.warningSnapshots,1);
 assert.equal(s.warnedThenSettledLoser,1);
 assert.equal(s.noAutomaticProfitProtectionChanges,true);
 assert.equal(s.noBrokerOrders,true);
});
test('late future outcomes are missing, not reconstructed from subsequently updated quotes',()=>{
 const r={assessedAt:iso(time),horizonMinutes:5};
 const q=quotes(time+6*60000);
 const a=model.labelMature(r,row(),q,time+7*60000,12);
 assert.equal(a.state,'MISSED_REALTIME_OUTCOME_WINDOW');
 assert.equal(a.notBackfilled,true);
 assert.equal(model.labelMature(r,row(),q,time+2*60000,12),null);
});
test('future quote must be observed AFTER its horizon, within an on-time 90s window',()=>{
 const r={assessedAt:iso(time-5*60000),horizonMinutes:5};
 const early=model.labelMature(r,row(),quotes(),time,12);
 assert.equal(early.state,'NO_FRESH_ASOF_HORIZON_MARK');
 const later=time+52000;
 const future=model.quote(raw('2026-11-20T16:05:00Z',1.10011),later);
 assert.ok(future);
 const q=[future,...quotes(later)];
 const a=model.labelMature(r,row(),q,later,12);
 assert.equal(a.state,'REALTIME_BROKER_NATIVE_PRICE_MARK_ONLY');
 assert.ok(a.sampledSecondsAfterForecastHorizon>=0);
 assert.equal(a.markIsNotExactHorizonFill,true);
 assert.equal(a.noBrokerFillClaim,true);
 assert.equal(a.noGuaranteedRecoveryClaim,true);
 assert.equal(typeof a.theoreticalNetAfterEstimatedFeeUsd,'number');
});
test('two warnings on one trade never double-count a broker settlement as savings',()=>{
 const id='6ed0ae55-4e31-4d22-9074-55c97800397a';
 const recorded={tradeId:id,openedAt:iso(time-5*60000),
  settled:{netUsd:-195},snapshots:{}};
 for(const m of [1,3])recorded.snapshots[m]={checkpointMinute:m,
  signal:{state:'TOWARD_ORIGINAL_STOP'},
  futures:Object.fromEntries(model.HORIZONS.map(h=>[h,{actual:null}]))};
 const r=watcher.summary({trades:{[id]:recorded}},marker,time);
 assert.equal(r.warningSnapshots,2);
 assert.equal(r.warnedDistinctTrades,1);
 assert.equal(r.warnedThenActuallySettled,1);
 assert.equal(r.warnedThenSettledLoser,1);
 assert.equal(r.realizedNetUsdOnWarnedDistinctTrades,-195);
 assert.equal(r.noAutomaticProfitProtectionChanges,true);
});

test('pre-open broker fee sample freezes a validated 4.9-lot USD commission reserve',()=>{
 const t=row({opened_at:iso(time-15000),lot_size:'4.9',
  sizing_inputs:{},historical_fee_per_lot:'6.00000',
  min_fee_per_lot:'6',max_fee_per_lot:'6',fee_samples:32});
 const proof=watcher.feeEvidence(t);
 assert.equal(proof.source,'PRIOR_SETTLED_BROKER_FEES_BEFORE_OPEN');
 assert.equal(proof.priorSettledSampleCount,32);
 assert.equal(proof.feePerLot,6);
 assert.equal(proof.reserveUsd,29.4);
 const frozen=watcher.enroll(t,marker,time);
 assert.equal(frozen.feeReserveUsd,29.4);
 assert.equal(frozen.feeReserveSource,'PRIOR_SETTLED_BROKER_FEES_BEFORE_OPEN');
 assert.equal(frozen.feeEvidencePriorSettlements,32);
 assert.equal(watcher.feeReserve(t),29.4);
});
test('as-of fee evidence MUST predate target opening and remain owner/broker scoped',()=>{
 const sql=watcher.FEES_SQL;
 for(const value of [
  'h.user_id=$1 AND h.broker_connection_id=$2',
  "h.account_currency='USD' AND h.status='CLOSED'",
  'h.closed_at<$3::timestamptz',
  "h.opened_at>=$3::timestamptz-interval '7 days'",
  'h.commission<0 AND h.lot_size>0',
  'ORDER BY h.closed_at DESC LIMIT 32',
 ])assert.ok(sql.includes(value),value);
 assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
});
test('missing, unstable and insufficient broker cost history never invent a fee reserve',()=>{
 const base={...row(),sizing_inputs:{},
  historical_fee_per_lot:'6',min_fee_per_lot:'6',
  max_fee_per_lot:'6',fee_samples:32};
 assert.equal(watcher.feeReserve(base),12);
 for(const change of [
  {fee_samples:11},{fee_samples:33},
  {min_fee_per_lot:'5',max_fee_per_lot:'6'},
  {historical_fee_per_lot:'NaN'},
  {historical_fee_per_lot:'7'},
  {fee_samples:null},{max_fee_per_lot:null},
 ])assert.equal(watcher.feeReserve({...base,...change}),null,JSON.stringify(change));
});
test('an as-of pre-fill allocation has source precedence over historical fee fallback',()=>{
 const t=row({historical_fee_per_lot:'6',fee_samples:32,
  min_fee_per_lot:'6',max_fee_per_lot:'6'});
 assert.equal(watcher.feeEvidence(t).source,'PRE_FILL_ALLOCATION_HISTORICAL_FEE');
 assert.equal(watcher.feeReserve(t),12);
});
