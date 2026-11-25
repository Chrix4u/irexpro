'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const audit=require('./audit-owner-demo-loss-entry-forensics.cjs');
const opened='2026-11-17T10:00:12.000Z';
const closed='2026-11-17T10:08:00.000Z';
const row=(changes={})=>({
 trade_id:'abc-test-id',instrument:'USDJPY',direction:'BUY',
 opened_at:opened,closed_at:closed,
 lot_size:'1.5',status:'CLOSED',
 close_reason:'BROKER_CLOSE',
 realised_pnl:'-30.0',commission:'-9.0',swap:'0',
 fill_price:'153.120',exit_price:'153.085',
 stop_loss:'153.080',take_profit:'153.220',
 max_favorable_pnl:'21.0',max_adverse_pnl:'-34.0',
 path_observation_count:40,path_peak_observed_at:'2026-11-17T10:01:30Z',
 initial_risk:'50.0',fallback_risk:'60.0',
 trade_intent_id:'t1',decision_id:'d1',decision_at:'2026-11-17T10:00:00Z',
 m1_route:'ABSTAIN',outcome_state:'EXECUTION_SUCCEEDED',
 metadata:{multimodel_plan_b_route:'EARLY_TRANSITION',
  multimodel_execution_authority_path:'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE',
  multimodel_governance_net_expected_r:0.32},
 candidate:{direction:'BUY',alignedH1:-0.4,alignedM5:-0.4,alignedMomentum3Atr:-0.6},
 governance:{
  multimodelEnsemble:{regime:'TRANSITION_EARLY',ensembleScore:0.69,metaProbability:0.52,
   paperAdmitted:true,consensusPassed:7,consensusRequired:6},
  multimodelTrainedExpert:{state:'ABSTAIN',direction:'BUY',longVotes:2,shortVotes:1},
  multimodelGovernance:{estimatedExecutionCostR:0.06},
 },
 ...changes,
});
const quote=(at='2026-11-17T10:01:00.000Z',changes={})=>({
 instrument:'USDJPY',bucket_time:at,bid_close:'153.14',ask_close:'153.15',
 source:'ctrader-broker-native',sample_count:10,positive_quote_sample_count:8,
 last_positive_sample_at:'2026-11-17T10:01:52.000Z',
 ...changes,
});
const asOf=Date.parse('2026-11-17T11:00:00Z');
test('net uses signed broker commission and swap once',()=>{
 assert.equal(audit.net(row()),-39);
 assert.equal(audit.net(row({commission:null})),null);
 assert.equal(audit.net(row({swap:'-2.1'})),-41.1);
});
test('peak is not an actual realised gain and above-fee peak may still lose',()=>{
 const sample=audit.makeRecords([row()],{},asOf)[0];
 assert.equal(sample.maxFavorableBrokerNet,21);
 assert.equal(sample.commissionAbs,9);
 assert.equal(sample.peakAboveCommission,true);
 assert.equal(sample.netUsd,-39);
 assert(sample.flags.includes('POSITIVE_BROKER_NET_PEAK_GREATER_THAN_FINAL_COMMISSION_MAGNITUDE'));
 assert(sample.flags.includes('OBSERVED_PEAK_20_PLUS_THEN_LOSS'));
});
test('missing closing risk is UNKNOWN, not zero profit',()=>{
 const sample=audit.makeRecords([row({max_favorable_pnl:null})],{},asOf)[0];
 assert(sample.flags.includes('UNKNOWN_PEAK_EVIDENCE'));
 assert.equal(sample.peakAboveCommission,false);
});
test('only verified, late-bar-close broker quotes are accepted',()=>{
 assert.equal(audit.quoteUsable(quote(),asOf),true);
 assert.equal(audit.quoteUsable(quote(undefined,{source:'paper-synthetic'}),asOf),false);
 assert.equal(audit.quoteUsable(quote(undefined,{last_positive_sample_at:'2026-11-17T10:01:20.000Z'}),asOf),false);
 assert.equal(audit.quoteUsable(quote(undefined,{ask_close:'153.10'}),asOf),false);
 assert.equal(audit.quoteUsable(quote(undefined,{positive_quote_sample_count:0}),asOf),false);
});
test('one-minute quote is an OUTCOME label, never a fabricated trade',()=>{
 const markers=audit.sampledAfterEntry(row(),[quote()],asOf);
 assert.equal(markers['1m'].status,'VALID_BROKER_NATIVE_CLOSE');
 assert.equal(markers['1m'].directionAlignedPips,2);
 assert.equal(markers['1m'].notAnExecutableExit,true);
 assert.equal(markers['1m'].duringActualPositionOpen,true);
 assert.equal(markers['3m'].status,'NO_VALID_COMPLETED_NATIVE_QUOTE');
});
test('marks strictly after actual close cannot enter while-open comparison',()=>{
 const rows=[row({closed_at:'2026-11-17T10:01:38.000Z'})];
 const items=audit.makeRecords(rows,{USDJPY:[quote()]},asOf);
 assert.equal(items[0].futureSampledNativeQuoteOutcome['1m'].duringActualPositionOpen,false);
 const out=audit.firstMarkContrasts(items)['EARLY_TRANSITION 1m'];
 assert.equal(out.validQuotes,0);
});
test('missing independent expert approval is not equivalent to opposite vote',()=>{
 const x=audit.makeRecords([row()],{},asOf)[0];
 assert(x.flags.includes('INDEPENDENT_TRAINED_EXPERT_ABSTAINED'));
 assert(!x.flags.includes('INDEPENDENT_EXPERT_OPPOSITE_AT_ENTRY'));
 assert.match(x.oppositeDirectionInterpretation,/No verified independently admitted opposite/);
});
test('a truly opposite directional vote stays labeled research-only',()=>{
 const special=row({governance:{...row().governance,
   multimodelTrainedExpert:{state:'ABSTAIN',direction:'SELL',longVotes:1,shortVotes:2}}});
 const x=audit.makeRecords([special],{},asOf)[0];
 assert(x.flags.includes('INDEPENDENT_EXPERT_OPPOSITE_AT_ENTRY'));
 assert.match(x.oppositeDirectionInterpretation,/not permission to reverse/);
});
test('causal candidate pattern is compared with winners, not losses alone',()=>{
 const good=row({trade_id:'other',realised_pnl:'55',commission:'-9'});
 const items=audit.makeRecords([row(),good],{},asOf);
 const g=audit.causalPatternContrast(items).find(x=>
   x.pattern==='EXPERT_ABSTAIN'&&x.route==='EARLY_TRANSITION');
 assert.equal(g.flaggedEntries,2);
 assert.equal(g.flaggedLosses,1);
 assert.equal(g.flaggedWinners,1);
 assert.equal(g.flaggedNetUsd,7);
 assert.equal(g.retrospectivePatternMining,true);
});
test('route comes from exact broker trade-intent, not primary M1 ABSTAIN',()=>{
 const x=audit.makeRecords([row()],{},asOf)[0];
 assert.equal(x.route,'EARLY_TRANSITION');
 assert.equal(x.entry.decisionRoute,'ABSTAIN');
 assert.equal(x.entry.lineagePresent,true);
});
test('source queries are read-only and exact owner / broker / USD DEMO scoped',()=>{
 assert.match(audit.TRADE_SQL,/b\.user_id=t\.user_id/);
 assert.match(audit.TRADE_SQL,/b\.broker_id='pepperstone-ctrader'/);
 assert.match(audit.TRADE_SQL,/b\.account_type='DEMO'/);
 assert.match(audit.TRADE_SQL,/t\.account_currency='USD'/);
 assert.match(audit.TRADE_SQL,/trade_intent_id=ti\.id/);
 assert.match(audit.TRADE_SQL,/d\.evaluated_at<=t\.opened_at/);
 assert.doesNotMatch(audit.TRADE_SQL,/\b(?:UPDATE|DELETE|INSERT)\b/i);
 assert.match(audit.QUOTE_SQL,/source='ctrader-broker-native'/);
});

test('hard-negative learning cohort includes winners and losers but freezes as-of inputs',()=>{
 const bad=row();
 const good=row({trade_id:'positive-1',realised_pnl:'100',commission:'-9',
   max_favorable_pnl:'120'});
 const items=audit.makeRecords([bad,good],{USDJPY:[quote()]},asOf);
 const corpus=audit.buildTrainingCohort(items,'2026-11-18T15:00:00Z');
 assert.equal(corpus.records.length,2);
 assert.deepEqual(corpus.records.map(v=>v.futureOutcomesDoNotUseAsInputs.label),
  ['NET_LOSS','NET_WIN']);
 assert.equal(corpus.records[0].entryFeatures.entryRoute,'EARLY_TRANSITION');
 assert.equal('netPnlUsd' in corpus.records[0].entryFeatures,false);
 assert.equal('peakUnrealisedBrokerNet' in corpus.records[0].entryFeatures,false);
 assert.equal('quoteHorizonOutcomes' in corpus.records[0].entryFeatures,false);
 assert.equal(corpus.modelWeightsUpdated,false);
 assert.match(corpus.warning,/Neither day is a pristine out-of-sample holdout/);
});
