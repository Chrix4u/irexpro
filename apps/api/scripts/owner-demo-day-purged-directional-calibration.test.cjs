'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {HORIZON,paired,fitPrior,evaluateDayPurgedDirection:run}
  =require('./owner-demo-day-purged-directional-calibration.cjs');
const e=(day,index,{route='CONFIRMED_REVERSAL',side='BUY',
  main=1,counter=-2,comparable=true,minute=10}={})=>({
  evaluated_at:day+'T'+String(Math.floor(index/50)+10).padStart(2,'0')+
    ':'+String((index*7+minute)%60).padStart(2,'0')+':00Z',
  planb_route:route,direction:side,
  outcomes:{[HORIZON]:{status:comparable?'PAIR_COMPARABLE':
    'MISSING_NATIVE_BID_ASK',chosenNetPips:main,reverseNetPips:counter}},
});
const prior=()=>['2026-11-16','2026-11-17','2026-11-18']
 .flatMap(day=>Array.from({length:9},(_,i)=>e(day,i)));
test('research never grants broker direction, entry-veto or sizing authority',()=>{
 const x=run([...prior(),e('2026-11-19',1)],new Date('2026-11-19T22:00:00Z'));
 assert.equal(x.mode,'RESEARCH_ONLY_NO_BROKER_AUTHORITY');
 assert.equal(x.noAutoDirectionFlip,true);
 assert.equal(x.noNewEntryVeto,true);
 assert.equal(x.noLotChange,true);
 assert.equal(x.noLivePromotion,true);
 assert.equal(x.qualifiedOutOfSample,1);
 assert.equal(x.currentDayPreview[0].preference,'MAIN_SIDE_SHADOW_PREFERRED');
});
test('same-day settled outcomes cannot influence another same-day forecast',()=>{
 const today=e('2026-11-19',1,{main:-100,counter:100});
 const a=run([...prior(),today],new Date('2026-11-19T22:00:00Z'));
 const b=run([...prior(),today,e('2026-11-19',2,
   {main:-10000,counter:10000})],new Date('2026-11-19T22:00:00Z'));
 assert.equal(a.currentDayPreview[0].priorEpisodes,27);
 assert.equal(b.currentDayPreview[0].priorEpisodes,27);
 assert.equal(a.currentDayPreview[0].preference,b.currentDayPreview[1].preference);
 assert.equal(a.currentDayPreview[0].meanMainNetPips,1);
});
test('strong apparent same-day profits cannot rescue an undertrained side',()=>{
 const older=['2026-11-17','2026-11-18'].flatMap(day=>
   Array.from({length:12},(_,i)=>e(day,i,{main:5,counter:-3})));
 const x=run([...older,e('2026-11-19',1)],
   new Date('2026-11-19T22:00:00Z'));
 assert.equal(x.qualifiedOutOfSample,0);
 assert.equal(x.currentDayPreview[0].preference,'NO_DIRECTION_AUTHORITY');
});
test('counter preference is only shadow when prior market days support it',()=>{
 const evidence=prior().map(r=>({
  ...r,outcomes:{10:{status:'PAIR_COMPARABLE',
    chosenNetPips:-2,reverseNetPips:1.2}}}));
 const x=run([...evidence,e('2026-11-19',2)],
   new Date('2026-11-19T22:00:00Z'));
 assert.equal(x.currentDayPreview[0].preference,'COUNTER_SIDE_SHADOW_PREFERRED');
 assert.equal(x.noAutoDirectionFlip,true);
});
test('negative after-cost outcomes on both sides mean no proven direction',()=>{
 const evidence=prior().map(r=>({
  ...r,outcomes:{10:{status:'PAIR_COMPARABLE',
    chosenNetPips:-0.3,reverseNetPips:-1.3}}}));
 const x=run([...evidence,e('2026-11-19',3)],
   new Date('2026-11-19T22:00:00Z'));
 assert.equal(x.currentDayPreview[0].preference,
   'NO_CONSISTENT_AFTER_COST_DIRECTIONAL_EDGE');
});
test('cannot train from another route or another candidate side',()=>{
 const priorOther=prior().map(r=>({...r,direction:'SELL'}));
 const x=run([...priorOther,e('2026-11-19',1)],
   new Date('2026-11-19T22:00:00Z'));
 assert.equal(x.currentDayPreview[0].priorDays,0);
 assert.equal(x.currentDayPreview[0].preference,'NO_DIRECTION_AUTHORITY');
});
test('missing broker quotes, nil pips and future samples never become wins',()=>{
 assert.equal(paired(e('2026-11-18',1,{comparable:false})),null);
 assert.equal(paired(e('2026-11-18',1,{main:null})),null);
 const x=run([...prior(),e('2026-11-19',1,{comparable:false})],
   new Date('2026-11-19T22:00:00Z'));
 assert.equal(x.qualifiedOutOfSample,0);
 assert.equal(x.currentDayPreview.length,0);
});
test('outcomes crossing UTC midnight are never trained the next day',()=>{
 const old=prior();
 const nearMidnight=e('2026-11-18',3);
 nearMidnight.evaluated_at='2026-11-18T23:50:00Z';
 const x=run([...old,nearMidnight,e('2026-11-19',1)],
   new Date('2026-11-19T22:00:00Z'));
 assert.equal(x.currentDayPreview[0].priorEpisodes,27);
});
test('missing or invalid research input errors instead of granting authority',()=>{
 assert.throws(()=>run(null),/INVALID_DIRECTIONAL_RESEARCH_INPUT/);
 assert.throws(()=>run([],new Date('invalid')),/INVALID_DIRECTIONAL_RESEARCH_INPUT/);
 assert.equal(fitPrior([]).preference,'NO_DIRECTION_AUTHORITY');
});
