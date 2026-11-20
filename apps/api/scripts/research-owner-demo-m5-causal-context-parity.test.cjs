'use strict';
const t=require('node:test'),a=require('node:assert/strict');
const {ARTIFACT,WIDTH,MINUTE,nativeM1Rollup,quoteM5AsOf,
  nativeM5Outcome,comparison,aggregate}=require('./research-owner-demo-m5-causal-context-parity.cjs');
const start=Date.parse('2026-11-17T18:00:00Z'),cutoff=start+WIDTH+15000;
const date=x=>new Date(x).toISOString();
function m1(n=5,upAfter=false){
 return Array.from({length:n},(_,i)=>{
  const o=1.1+i*.00001,c=o+.000006;
  return {bucket_time:date(start+i*MINUTE),open:o,high:c+.000015,
    low:o-.000015,close:c,sample_count:20,positive_quote_sample_count:3,
    last_quote_sample_at:date(start+(i+1)*MINUTE-1500),
    created_at:date(start+i*MINUTE+2000),
    updated_at:date(start+(i+1)*MINUTE+(upAfter?180000:4000))};
 });
}
function quotes(tickStep=2000){
 const rows=[];
 for(let i=0;i<5;i++){
  for(let off=1000;off<60000;off+=tickStep){
   const source=start+i*MINUTE+off;
   const mid=1.1+i*.00001+off*.000000001;
   rows.push({instrument:'EURUSD',source,observed:source+1000,bid:mid-.000005,ask:mid+.000005});
  }
 }
 return rows;
}
const native=()=>({instrument:'EURUSD',timeframe:'M5',
 bucket_time:date(start),source:'ctrader-broker-native',sample_count:50,
 open:1.1,high:1.100061,low:1.099985,close:1.100046,
 created_at:date(start+WIDTH+39000),updated_at:date(start+WIDTH+90000)});
t('M1 native rollup uses exactly five adjacent completed buckets',()=>{
 const roll=nativeM1Rollup(m1(),start,cutoff);
 a.equal(roll.status,'COMPLETE_RETROSPECTIVE_M1_ROLLUP');
 a.equal(roll.open,1.1);
 a.ok(Math.abs(roll.close-1.100046)<1e-8);
 a.equal(roll.allM1RowsCreatedByCutoff,true);
 a.equal(roll.lastM1UpdateByCutoff,true);
 a.equal(roll.dbMutableAsOfCertified,false);
});
t('missing or duplicated M1 bars refuse to manufacture M5',()=>{
 a.equal(nativeM1Rollup(m1(4),start,cutoff).status,'MISSING_OR_DUPLICATE_NATIVE_M1');
 const data=m1();data[3].bucket_time=data[2].bucket_time;
 a.equal(nativeM1Rollup(data,start,cutoff).status,'INVALID_OR_UNVERIFIED_M1_SAMPLE');
});
t('post-cutoff M1 revision is never certified as as-of available',()=>{
 const data=m1(5,true),roll=nativeM1Rollup(data,start,cutoff);
 a.equal(roll.status,'COMPLETE_RETROSPECTIVE_M1_ROLLUP');
 a.equal(roll.lastM1UpdateByCutoff,false);
 a.equal(roll.dbMutableAsOfCertified,false);
});
t('positive archived quotes build sampled path observed before cutoff',()=>{
 const result=quoteM5AsOf(quotes(),'EURUSD',start,cutoff);
 a.equal(result.status,'CERTIFIED_ASOF_QUOTE_SAMPLE');
 a.equal(result.minutesWithQuotes,5);
 a.equal(result.quotePathAvailableByDecision,true);
 a.equal(result.fullTickOhlc,false);
 a.equal(result.noFutureBarInformation,true);
 a.ok(result.high>=result.close);
 a.ok(result.low<=result.open);
});
t('quote archive cannot use quote first observed after decision cutoff',()=>{
 const late=quotes();
 for(const q of late)if(q.source>=start+4*MINUTE)q.observed=cutoff+1000;
 const result=quoteM5AsOf(late,'EURUSD',start,cutoff);
 a.equal(result.status,'MISSING_REALTIME_QUOTE_MINUTE');
});
t('a whole missing minute or stale last minute cannot count as as-of M5',()=>{
 const missing=quotes().filter(q=>q.source<start+MINUTE||q.source>=start+2*MINUTE);
 a.equal(quoteM5AsOf(missing,'EURUSD',start,cutoff).status,'MISSING_REALTIME_QUOTE_MINUTE');
 const old=quotes().filter(q=>q.source<start+4*MINUTE+45000);
 a.equal(quoteM5AsOf(old,'EURUSD',start,cutoff).status,'STALE_FINAL_MINUTE_QUOTE');
});
t('late first native quote of a minute is excluded even with full samples',()=>{
 const late=quotes().filter(q=>q.source<start+3*MINUTE||
   q.source>=start+3*MINUTE+14000);
 a.equal(quoteM5AsOf(late,'EURUSD',start,cutoff).status,'LATE_FIRST_QUOTE_IN_MINUTE');
});
t('wrong instrument or immature cutoff is rejected',()=>{
 a.throws(()=>quoteM5AsOf(quotes(),'GBPUSD',start,cutoff),/INVALID_ASOF_CONTEXT/);
 a.throws(()=>quoteM5AsOf(quotes(),'EURUSD',start,start+WIDTH-15000),/INVALID_ASOF_CONTEXT/);
 a.throws(()=>nativeM1Rollup(m1(),start,start+WIDTH-10),/INVALID_CLOSED/);
});
t('native M5 created late is never counted as available at early slot',()=>{
 const actual=nativeM5Outcome(native(),start);
 a.ok(actual);
 a.equal(actual.nativeM5CreatedAt>cutoff,true);
 const prev=nativeM1Rollup(m1(),start,cutoff);
 const deviation=comparison(actual,prev,'EURUSD');
 a.ok(deviation);
 a.equal(deviation.allOhlcWithinPoint5Pip,true);
 a.equal(prev.dbMutableAsOfCertified,false);
});
t('quote M5 mid-path comparison is not a guaranteed native-M5 fill',()=>{
 const actual=nativeM5Outcome(native(),start);
 const sample=quoteM5AsOf(quotes(),'EURUSD',start,cutoff);
 const deviations=comparison(actual,sample,'EURUSD');
 a.ok(deviations);
 a.equal(sample.quoteSampleOHLCNotNativeM5,true);
 a.equal(sample.fullTickOhlc,false);
 a.ok(deviations.maxOhlcDeviationPips>=0);
});
t('native M5 invalid shape and provenance cannot enter report',()=>{
 const x=native();x.source='other';
 a.equal(nativeM5Outcome(x,start),null);
 const y=native();y.high=1.05;
 a.equal(nativeM5Outcome(y,start),null);
});
t('rollup metrics never declare price parity sufficient for trading authority',()=>{
 const roll=nativeM1Rollup(m1(),start,cutoff);
 const nativeBar=nativeM5Outcome(native(),start);
 const c=quoteM5AsOf(quotes(),'EURUSD',start,cutoff);
 const d={instrument:'EURUSD',start,decisionAt:cutoff,
   nativeCreatedByNext15s:false,nativeDelaySeconds:39,
   m1:roll,quote:c,m1Comparison:comparison(nativeBar,roll,'EURUSD'),
   quoteComparison:comparison(nativeBar,c,'EURUSD')};
 const report=aggregate([d]);
 a.equal(report.completedNativeM5,1);
 a.equal(report.nativeM5CreatedByNext15s,0);
 a.equal(report.mutableDbM1AsOfCertified,0);
 a.equal(report.certifiedQuotedPartialM5,1);
 a.equal(report.m1.comparable,1);
 a.equal(report.quote.comparable,1);
 a.equal(ARTIFACT,'irexpro-owner-demo-m5-causal-context-parity-v1');
});
