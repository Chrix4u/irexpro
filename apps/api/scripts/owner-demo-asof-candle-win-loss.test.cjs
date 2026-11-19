'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validSnapshot,derive,annotate,analyze}=require('./owner-demo-asof-candle-win-loss.cjs');
const asOf='2026-11-19T12:00:00.000Z';
const earlier='2026-11-19T11:59:45.000Z';
function sample(time=earlier,changes={}){
 return {
  artifact:'irexpro-forming-candle-asof-quote-shadow-v1',
  instrument:'EURUSD',timeframe:'M1',barStart:'2026-11-19T11:59:00.000Z',
  decisionAt:time,elapsedSeconds:45,stageSecondWithinMinute:45,
  open:1.1000,high:1.1006,low:1.0998,close:1.1004,
  body:.0004,range:.0008,color:'GREEN',
  upperWick:.0002,lowerWick:.0002,closeLocation:.75,
  lastSpread:.00002,sampleCount:5,
  firstSourceAt:'2026-11-19T11:59:02.000Z',
  lastSourceAt:'2026-11-19T11:59:43.000Z',
  lastObservedAt:'2026-11-19T11:59:44.000Z',
  sourceProvenance:'ctrader-broker-native-positive-quote-archive',
  brokerOrderAuthority:false,modifiesExecution:false,
  includesNextBarLabel:false,fromCompletedFutureCandle:false,fullTickOhlc:false,
  ...changes,
 };
}
const trade=(id,dir='BUY',netUsd=10)=>({
  tradeKey:id,decisionAt:asOf,instrument:'EURUSD',direction:dir,
  matchedDecision:true,tradeDate:'2026-11-19',entryRoute:'CONFIRMED_REVERSAL',
  label:netUsd>0?'WIN':'LOSS',netUsd,entry:{alignedH1:-.3},
});
test('historical revised candles and future as-of quotes cannot masquerade as entry evidence',()=>{
 const t=trade('x');
 assert.equal(validSnapshot(sample(),t),true);
 assert.equal(validSnapshot(sample('2026-11-19T12:00:15.000Z'),t),false);
 assert.equal(validSnapshot(sample(earlier,{lastObservedAt:'2026-11-19T12:00:01.000Z'}),t),false);
 assert.equal(validSnapshot(sample(earlier,{fromCompletedFutureCandle:true}),t),false);
 assert.equal(validSnapshot(sample(earlier,{lastSpread:0}),t),false);
 assert.equal(validSnapshot(sample(earlier,{sampleCount:1}),t),false);
 assert.equal(validSnapshot(sample(earlier,{decisionAt:'2026-11-19T11:57:45.000Z'}),t),false);
});
test('direction-relative sampled wick and body change sign when BUY becomes SELL',()=>{
 const buy=derive(sample(),'BUY'),sell=derive(sample(),'SELL');
 assert.equal(buy.bodyAlignedRatio,.5);
 assert.equal(sell.bodyAlignedRatio,-.5);
 assert.equal(buy.closeAligned,.5);
 assert.equal(sell.closeAligned,-.5);
 assert.equal(buy.fullTickOhlc,false);
});
test('joins only same-instrument time-frozen quote snapshots with missing evidence counted',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'irex-candle-asof-test-'));
 try{
  const m5=sample(earlier,{timeframe:'M5',barStart:'2026-11-19T11:55:00.000Z',
    elapsedSeconds:285});
  const future=sample('2026-11-19T12:00:15.000Z',{barStart:'2026-11-19T12:00:00.000Z',
    elapsedSeconds:15,lastSourceAt:'2026-11-19T12:00:13.000Z',
    lastObservedAt:'2026-11-19T12:00:14.000Z'});
  fs.writeFileSync(path.join(dir,'2026-11-19.jsonl'),[sample(),m5,future].map(JSON.stringify).join('\n')+'\n');
  const list=[trade('one','BUY',8),trade('two','SELL',-4),
    {...trade('three'),instrument:'USDJPY'}];
  const archive=await annotate(list,dir);
  assert.equal(archive.coverage.verifiedBoth,2);
  assert.equal(archive.coverage.verifiedM1,2);
  assert.equal(archive.coverage.requestedTradeCount,3);
  assert.equal(archive.annotated.get('one').M1.at,earlier);
  assert.equal(archive.annotated.get('three').M1,null);
  const report=analyze(list,archive);
  assert.equal(report.changesExecution,false);
  assert.equal(report.fullTickCandleExpert,false);
  const flag=report.formationComparisons.find(x=>x.flag==='M5_FORMING_BODY_OPPOSES'&&x.route==='CONFIRMED_REVERSAL');
  assert.equal(flag.all.flagged.n,1);
  assert.equal(flag.all.flagged.losses,1);
  assert.equal(flag.all.unflagged.n,1);
  assert.equal(flag.all.unflagged.wins,1);
  assert.equal(flag.noExecutionAuthority,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
