'use strict';
/**
 * READ-ONLY diagnostics: Can five *complete* native M1 candles reproduce an M5
 * native candle? Can append-only broker-positive quotes reproduce that M5
 * independently, using ONLY quotes actually observed before +15s?
 *
 * Price parity is NOT as-of availability. Database M1 may be revised; only
 * immutable quote archive can establish true observation-time provenance.
 * Neither output has trade authority nor is a native-M5 model substitute.
 */
const WIDTH=300000,MINUTE=60000;
const INSTRUMENTS=Object.freeze(['EURUSD','AUDUSD','USDJPY','USDCAD']);
const PIP=Object.freeze({EURUSD:1e-4,AUDUSD:1e-4,USDJPY:1e-2,USDCAD:1e-4});
const ARTIFACT='irexpro-owner-demo-m5-causal-context-parity-v1';
const ms=x=>{const n=new Date(x).getTime();return Number.isFinite(n)?n:null;};
const numeric=x=>{if(x===null||x===undefined||x==='')return null;const n=Number(x);return Number.isFinite(n)?n:null};
function nativeM1Rollup(rows,start,decisionAt){
  if(!Number.isSafeInteger(start)||start%WIDTH||!(decisionAt>=start+WIDTH))
    throw Error('INVALID_CLOSED_M5_WINDOW');
  if(!Array.isArray(rows))return {status:'NO_M1_CANDLES'};
  const selected=rows.filter(x=>ms(x.bucket_time)>=start&&ms(x.bucket_time)<start+WIDTH);
  if(selected.length!==5)return {status:'MISSING_OR_DUPLICATE_NATIVE_M1',count:selected.length};
  const bars=selected.sort((a,b)=>ms(a.bucket_time)-ms(b.bucket_time));
  for(let i=0;i<5;i++){
    const b=bars[i],o=numeric(b.open),h=numeric(b.high),l=numeric(b.low),
      c=numeric(b.close),n=numeric(b.sample_count),pos=numeric(b.positive_quote_sample_count),
      last=ms(b.last_quote_sample_at),firstAdded=ms(b.created_at),latestChange=ms(b.updated_at);
    if(ms(b.bucket_time)!==start+i*MINUTE||o===null||h===null||l===null||c===null||
      !(o>0&&l>0&&h>=Math.max(o,c)&&l<=Math.min(o,c))||
      n===null||n<2||pos===null||pos<2||
      last===null||last<start+i*MINUTE||last>=start+(i+1)*MINUTE||
      firstAdded===null||latestChange===null)
      return {status:'INVALID_OR_UNVERIFIED_M1_SAMPLE',index:i};
  }
  const lastUpdated=Math.max(...bars.map(b=>ms(b.updated_at)));
  const firstCreated=Math.max(...bars.map(b=>ms(b.created_at)));
  const eligibleCreated=firstCreated<=decisionAt;
  const eligibleUnrevised=lastUpdated<=decisionAt;
  // May be used only as a retrospective OHLC *comparison*: PostgreSQL
  // mutable rows have no append-only evidence that OHLC were final at
  // decisionAt even if the current updated_at happens to be <= cutoff.
  const reconstructed={
    open:numeric(bars[0].open),high:Math.max(...bars.map(b=>numeric(b.high))),
    low:Math.min(...bars.map(b=>numeric(b.low))),close:numeric(bars[4].close),
  };
  return {
    status:'COMPLETE_RETROSPECTIVE_M1_ROLLUP',...reconstructed,
    allM1RowsCreatedByCutoff:eligibleCreated,
    lastM1UpdateByCutoff:eligibleUnrevised,
    dbMutableAsOfCertified:false,
    firstAllM1CreationAt:new Date(firstCreated).toISOString(),
    lastM1UpdateAt:new Date(lastUpdated).toISOString(),
  };
}
function quoteM5AsOf(quoteRows,instrument,start,decisionAt){
  if(!INSTRUMENTS.includes(instrument)||start%WIDTH||decisionAt<start+WIDTH||
    decisionAt>=start+WIDTH+MINUTE)throw Error('INVALID_ASOF_CONTEXT_TARGET');
  const list=(Array.isArray(quoteRows)?quoteRows:[])
    .filter(q=>q&&q.instrument===instrument&&q.source>=start&&q.source<start+WIDTH&&
       q.observed<=decisionAt&&q.source<=q.observed&&q.observed-q.source<=10000&&
       q.ask>q.bid&&q.bid>0)
    .sort((a,b)=>a.source-b.source||a.observed-b.observed);
  const minutes=Array.from({length:5},(_,i)=>list.filter(x=>
    x.source>=start+i*MINUTE&&x.source<start+(i+1)*MINUTE));
  const counts=minutes.map(x=>x.length);
  if(counts.some(n=>n<2))return {status:'MISSING_REALTIME_QUOTE_MINUTE',counts};
  if(minutes.some((x,i)=>x[0].source-(start+i*MINUTE)>12000))
    return {status:'LATE_FIRST_QUOTE_IN_MINUTE',counts};
  const last=minutes[4].at(-1);
  if(start+WIDTH-last.source>8500||
      decisionAt-last.observed>25000)return {status:'STALE_FINAL_MINUTE_QUOTE',counts};
  const mids=list.map(q=>(q.bid+q.ask)/2);
  return {status:'CERTIFIED_ASOF_QUOTE_SAMPLE',open:mids[0],
    high:Math.max(...mids),low:Math.min(...mids),
    close:mids.at(-1),sourceSampleCount:list.length,minutesWithQuotes:5,
    firstObservedAt:new Date(list[0].observed).toISOString(),
    lastObservedAt:new Date(last.observed).toISOString(),
    quotePathAvailableByDecision:true,
    fullTickOhlc:false,
    quoteSampleOHLCNotNativeM5:true,
    noFutureBarInformation:true};
}
function nativeM5Outcome(row,start){
  if(!row||ms(row.bucket_time)!==start||
     row.source!=='ctrader-broker-native'||numeric(row.sample_count)<2)
    return null;
  const o=numeric(row.open),h=numeric(row.high),l=numeric(row.low),c=numeric(row.close);
  if([o,h,l,c].some(x=>x===null)||!(o>0&&l>0&&h>=Math.max(o,c)&&l<=Math.min(o,c)))
    return null;
  return {open:o,high:h,low:l,close:c,
    nativeM5CreatedAt:ms(row.created_at),
    nativeM5UpdatedAt:ms(row.updated_at)};
}
function comparison(native,reconstruction,inst){
  if(!native||!reconstruction||!reconstruction.status?.includes('ROLLUP')&&
      reconstruction.status!=='CERTIFIED_ASOF_QUOTE_SAMPLE')return null;
  const pip=PIP[inst];
  const differences=Object.fromEntries(['open','high','low','close'].map(k=>
    [k,Math.abs(native[k]-reconstruction[k])/pip]));
  return {absDeviationPips:differences,
    maxOhlcDeviationPips:Math.max(...Object.values(differences)),
    openCloseWithinPoint3Pip:differences.open<=.3&&differences.close<=.3,
    allOhlcWithinPoint5Pip:Object.values(differences).every(v=>v<=.5)};
}
function percentile(a,q){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.ceil(q*s.length)-1];}
function aggregate(rows){
  const n=rows.length, available=x=>rows.filter(r=>r[x]);
  const summary={
    completedNativeM5:n,
    nativeM5CreatedByNext15s:rows.filter(r=>r.nativeCreatedByNext15s).length,
    missingM1Rollup:rows.filter(r=>r.m1.status!=='COMPLETE_RETROSPECTIVE_M1_ROLLUP').length,
    completeRetrospectiveM1:available('m1Comparison').length,
    currentM1RowsAllCreatedByCutoff:rows.filter(r=>r.m1.allM1RowsCreatedByCutoff).length,
    currentM1RowsNotRevisedAfterCutoff:rows.filter(r=>r.m1.lastM1UpdateByCutoff).length,
    mutableDbM1AsOfCertified:0,
    certifiedQuotedPartialM5:available('quoteComparison').length,
    quoteCoverageRejected:rows.filter(r=>r.quote.status!=='CERTIFIED_ASOF_QUOTE_SAMPLE').length,
  };
  for(const [field,kind] of [['m1Comparison','m1'],['quoteComparison','quote']]){
    const valid=available(field);
    const deltas=valid.map(x=>x[field].maxOhlcDeviationPips);
    summary[kind]={comparable:valid.length,
      medianMaxOhlcDeviationPips:percentile(deltas,.5),
      p90MaxOhlcDeviationPips:percentile(deltas,.9),
      withinHalfPipAllOhlc:valid.filter(x=>x[field].allOhlcWithinPoint5Pip).length,
      withinPoint3PipOpenClose:valid.filter(x=>x[field].openCloseWithinPoint3Pip).length,
      caveat:kind==='m1'?'MUTABLE_DB_ROW_RETROSPECTIVE_PARITY_ONLY':
        'IMMUTABLE_QUOTE_TIMESTAMPS_ASOF_BUT_SAMPLED_PRICE_PATH_NOT_NATIVE_M5'
    };
  }
  const late=rows.map(r=>r.nativeDelaySeconds).filter(Number.isFinite);
  summary.nativeM5CreationDelaySeconds={
    median:percentile(late,.5),p90:percentile(late,.9),max:late.length?Math.max(...late):null};
  return summary;
}
module.exports={ARTIFACT,WIDTH,MINUTE,INSTRUMENTS,PIP,ms,numeric,
  nativeM1Rollup,quoteM5AsOf,nativeM5Outcome,comparison,aggregate};
