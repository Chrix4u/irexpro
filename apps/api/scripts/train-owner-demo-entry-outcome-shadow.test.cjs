'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {
 fitLogistic,auc,validation,buildTrainingResult,generatedSource,
}=require('./train-owner-demo-entry-outcome-shadow.cjs');
const F=['alignedM5','m5Body','alignedH1','alignedH4','alignedM1Momentum3','planBScore','forecastNetR'];
function entry(day,close,win,shift=0,route='CONFIRMED_REVERSAL'){
 const features=Object.fromEntries(F.map((k,i)=>[k,(win?.8:-.8)+shift*.001+i*.01]));
 return {matchedDecision:true,entryRoute:route,openedAt:day+'T10:00:00.000Z',
  closedAt:close+'T10:04:00.000Z',
  label:win?'WIN':'LOSS',netUsd:win?20:-30,netUsdPerLot:win?10:-15,
  entry:{...features,alignedM5:features.alignedM5,m5Body:features.m5Body,
   alignedH1:features.alignedH1,alignedH4:features.alignedH4,
   alignedM1Momentum3:features.alignedM1Momentum3,
   planBScore:.6+(win?.1:-.1),forecastNetR:win?.4:-.2}};
}
const training=Array.from({length:40},(_,i)=>entry('2026-11-18','2026-11-18',i<20,i));
test('regularized logistic model ranks clearly separated synthetic wins higher',()=>{
 const features=training.map(x=>({
  ...x,features:{
   alignedM5:x.entry.alignedM5,m5Body:x.entry.m5Body,
   alignedH1:x.entry.alignedH1,alignedH4:x.entry.alignedH4,
   alignedM1Momentum3:x.entry.alignedM1Momentum3/2,
   planBScore:(x.entry.planBScore-.6)/.2,
   forecastNetR:x.entry.forecastNetR,
  },
 }));
 const model=fitLogistic(features);
 assert.ok(model);
 assert.equal(model.samples,40);
 assert.equal(model.coefficients.length,7);
 assert.equal(model.coefficients.every(Number.isFinite),true);
 assert.ok(auc(features,model)>.9);
});
test('training excludes any label that closed after cutoff even when entry was earlier',()=>{
 const leaked=entry('2026-11-18','2026-11-19',false,99);
 const legitimate=training.concat([leaked]);
 const later=Array.from({length:15},(_,i)=>entry('2026-11-19','2026-11-19',i<8,i));
 const report=buildTrainingResult([...legitimate,...later],'0'.repeat(64));
 assert.equal(report.population.allRows,56);
 assert.equal(report.population.training.count,40);
 assert.equal(report.population.later.count,15);
 assert.equal(report.noExecutionAuthority,true);
 assert.equal(report.prospectiveQualification,'NOT_PROSPECTIVELY_QUALIFIED');
 assert.equal(report.selectionBias,'TRAINED_ON_EXECUTED_FILLS_ONLY');
 assert.equal(Object.hasOwn(report.artifact.routes,'EARLY_TRANSITION'),false);
 assert.match(generatedSource(report.artifact),/RESEARCH_ONLY/);
});
test('holdout avoidance loss counts include sacrificed winning entries',()=>{
 const rows=[
  ...training.slice(0,15).map(x=>({...x,features:{
   alignedM5:x.entry.alignedM5,m5Body:x.entry.m5Body,
   alignedH1:x.entry.alignedH1,alignedH4:x.entry.alignedH4,
   alignedM1Momentum3:x.entry.alignedM1Momentum3/2,
   planBScore:(x.entry.planBScore-.6)/.2,
   forecastNetR:x.entry.forecastNetR,
  }})),
  ...training.slice(20,35).map(x=>({...x,features:{
   alignedM5:x.entry.alignedM5,m5Body:x.entry.m5Body,
   alignedH1:x.entry.alignedH1,alignedH4:x.entry.alignedH4,
   alignedM1Momentum3:x.entry.alignedM1Momentum3/2,
   planBScore:(x.entry.planBScore-.6)/.2,
   forecastNetR:x.entry.forecastNetR,
  }})),
 ];
 const model=fitLogistic(rows);
 const check=validation(rows,model,rows);
 assert.equal(check.heldOutIfSkipped.count+check.keptIfSkipped.count,rows.length);
 assert.equal(check.heldOutIfSkipped.wins+check.heldOutIfSkipped.losses,check.heldOutIfSkipped.count);
 assert.equal(check.noVetoAuthorized,true);
});
