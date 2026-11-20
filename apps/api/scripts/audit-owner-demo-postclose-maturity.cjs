#!/usr/bin/env node
'use strict';
// Historical, read-only owner USD DEMO research; never sends orders or broker stop amendments.
const fs=require('node:fs');
const path=require('node:path');
const INPUT='/home/lightworld/webapps/irexpro-research/exit-payoff/latest-nov20-from-0430-tp-first.json';
const OUTPUT='/home/lightworld/webapps/irexpro-research/exit-payoff/latest-postclose-maturity.json';
const HORIZONS=[5,15,30,60];
const ms=s=>s==null?NaN:Date.parse(s);
function classify(trade,minutes,asOf){
  if(trade.status!=='CLOSED'||!trade.closedAt)return 'OPEN';
  const close=ms(trade.closedAt),now=ms(asOf),end=close+minutes*60000;
  if(!Number.isFinite(close)||!Number.isFinite(now)||close>now)throw Error('INVALID_TRADE_TIME');
  if(end>now)return 'NOT_MATURE';
  const q=trade.afterCloseOriginalBarriers;
  if(!q||q.pathCoverage!=='CONTIGUOUS_SAMPLED_PATH')return 'INCOMPLETE_QUOTE_COVERAGE';
  if(!Number.isFinite(ms(q.firstQuoteAt))||ms(q.firstQuoteAt)-close>30000||
    !Number.isFinite(ms(q.lastQuoteAt))||ms(q.lastQuoteAt)<end-30000)
    return 'INCOMPLETE_QUOTE_COVERAGE';
  const tp=ms(q.firstTargetAt),sl=ms(q.firstStopAt);
  const target=Number.isFinite(tp)&&tp>=close&&tp<=end;
  const stop=Number.isFinite(sl)&&sl>=close&&sl<=end;
  if(target&&stop&&tp===sl)return 'AMBIGUOUS_SAME_SAMPLE';
  if(target&&(!stop||tp<sl))return 'TP_FIRST_SAMPLED';
  if(stop&&(!target||sl<tp))return 'SL_FIRST_SAMPLED';
  return 'NEITHER_WITHIN_HORIZON';
}
function count(trades,minutes,asOf){
  const x={total:trades.length,TP_FIRST_SAMPLED:0,SL_FIRST_SAMPLED:0,
    NEITHER_WITHIN_HORIZON:0,AMBIGUOUS_SAME_SAMPLE:0,NOT_MATURE:0,
    INCOMPLETE_QUOTE_COVERAGE:0,OPEN:0};
  for(const t of trades)x[classify(t,minutes,asOf)]++;
  x.matureEvaluable=x.TP_FIRST_SAMPLED+x.SL_FIRST_SAMPLED+
    x.NEITHER_WITHIN_HORIZON+x.AMBIGUOUS_SAME_SAMPLE;
  return x;
}
function summarize(data){
  if(data.artifact!=='irexpro-owner-pepperstone-usd-demo-20261120-0430-tp-first-readonly-v1'
     ||data.researchOnly!==true||data.brokerOrders!==false||!Array.isArray(data.trades))
     throw Error('SOURCE_SCOPE_INVALID');
  const {trades,asOf}=data;
  const cohorts={ALL:trades,PROFIT_PROTECTION:trades.filter(t=>t.closeReason==='PROFIT_PROTECTION'),
    AI_CLOSE_SIGNAL:trades.filter(t=>t.closeReason==='AI_CLOSE_SIGNAL'),
    BROKER_CLOSE:trades.filter(t=>t.closeReason==='BROKER_CLOSE')};
  const asSeries=ts=>Object.fromEntries(HORIZONS.map(h=>[h+'m',count(ts,h,asOf)]));
  const activation=ms('2026-11-20T09:28:43.000Z');
  const protectedTrades=cohorts.PROFIT_PROTECTION;
  const byProfitProtectionRollout={
    BEFORE:asSeries(protectedTrades.filter(t=>ms(t.closedAt)<activation)),
    AFTER:asSeries(protectedTrades.filter(t=>ms(t.openedAt)>=activation)),
    STRADDLED_EXCLUDED:asSeries(protectedTrades.filter(t=>ms(t.openedAt)<activation&&ms(t.closedAt)>=activation))};
  return {artifact:'owner-demo-postclose-maturity-research-v1',sourceAsOf:asOf,
    generatedAt:new Date().toISOString(),sourceTrades:trades.length,
    byCloseReason:Object.fromEntries(Object.entries(cohorts).map(([k,v])=>[k,asSeries(v)])),
    byProfitProtectionRollout,
    byInstrument:Object.fromEntries([...new Set(trades.map(t=>t.instrument))].sort()
       .map(k=>[k,asSeries(trades.filter(t=>t.instrument===k))])),
    readOnly:true,ordersSent:0,modifiesExecution:false,modifiesLotSize:false,
    limitations:['Sampled hypothetical after-close quote paths are not actual broker TP fills.',
      'A later sampled TP is not proof that continued holding would beat a protective close.',
      'Windows not yet elapsed are censored; unverified gaps remain excluded.',
      'Original intent TP/SL may differ from subsequently amended broker barriers.',
      'Transaction costs, slippage and margin cannot be inferred from this path alone.']};
}
function run(){
  const result=summarize(JSON.parse(fs.readFileSync(INPUT,'utf8')));
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true,mode:0o700});
  fs.writeFileSync(OUTPUT,JSON.stringify(result,null,2),{mode:0o600});
  console.log('OWNER_POSTCLOSE_MATURITY '+JSON.stringify({asOf:result.sourceAsOf,
    profitProtection15m:result.byCloseReason.PROFIT_PROTECTION['15m'],
    profitProtection30m:result.byCloseReason.PROFIT_PROTECTION['30m'],ordersSent:0}));
  return result;
}
module.exports={HORIZONS,classify,count,summarize,run};
if(require.main===module)run();
