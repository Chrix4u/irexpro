/**
 * Fail-safe recognition of a provider-installed PROFITABLE, more-protective
 * stop. Never grants permission to amend or widen an SL. Conservative only
 * for owner Pepperstone USD DEMO, and only when broker TP still matches the
 * exact authoritative TP. Database authority needs a separately verified,
 * atomic update before a delayed close may be permitted.
 */
export interface BrokerTighterProfitStopInput {
  guardEnabled: boolean;
  ownerUserId: string | null;
  userId: string;
  brokerId: string;
  accountType: string;
  accountCurrency: string | null;
  tradeCurrency: string | null;
  direction: string;
  instrument: string;
  brokerInstrument: string;
  brokerDirection: string;
  tradeLots: string | number | null;
  brokerLots: string | number | null;
  entry: string | number | null;
  mark: string | number | null;
  databaseStop: string | number | null;
  databaseTakeProfit: string | number | null;
  brokerStop: string | number | null;
  brokerTakeProfit: string | number | null;
}

export type BrokerTighterProfitStopAssessment = {
  preserveMoreProtectiveBrokerStop: boolean;
  reason: 'MORE_PROTECTIVE_PROFIT_STOP_PENDING_AUTHORITY_SYNC' |
    'NOT_VERIFIED_OR_NOT_MORE_PROTECTIVE';
  noOrderAction: true;
  needsAuthoritativeReconciliation: boolean;
};

export function evaluateBrokerTighterProfitStopPreservation(
  i: BrokerTighterProfitStopInput,
): BrokerTighterProfitStopAssessment {
  const reject:BrokerTighterProfitStopAssessment={
    preserveMoreProtectiveBrokerStop:false,
    reason:'NOT_VERIFIED_OR_NOT_MORE_PROTECTIVE',
    noOrderAction:true,
    needsAuthoritativeReconciliation:false,
  };
  if (!i.guardEnabled || !i.ownerUserId || i.ownerUserId!==i.userId ||
      i.brokerId!=='pepperstone-ctrader' ||
      i.accountType!=='DEMO' || i.accountCurrency!=='USD' ||
      i.tradeCurrency!=='USD' ||
      !['EURUSD','GBPUSD','AUDUSD','NZDUSD','USDJPY','USDCAD','USDCHF'].includes(i.instrument) ||
      i.instrument!==i.brokerInstrument ||
      i.direction!==i.brokerDirection ||
      (i.direction!=='BUY' && i.direction!=='SELL')) return reject;
  const price=(x:string|number|null):number|null=>{
    if(x===null || x==='' || typeof x==='boolean') return null;
    const value=Number(x);
    return Number.isFinite(value)&&value>0?value:null;
  };
  const lots=Number(i.tradeLots);
  const providerLots=Number(i.brokerLots);
  if(!Number.isFinite(lots)||!Number.isFinite(providerLots)||lots<=0||
     providerLots<=0||Math.abs(lots-providerLots)>0.00005) return reject;
  const [entry,mark,authoritySl,authorityTp,brokerSl,brokerTp]=[
    i.entry,i.mark,i.databaseStop,i.databaseTakeProfit,
    i.brokerStop,i.brokerTakeProfit,
  ].map(price);
  if([entry,mark,authoritySl,authorityTp,brokerSl,brokerTp].some(x=>x===null))
    return reject;
  const e=entry!,m=mark!,a=authoritySl!,tp=authorityTp!,
    bs=brokerSl!,bt=brokerTp!;
  const tick=i.instrument.endsWith('JPY')?0.001:0.00001;
  // Original risk geometry must be valid and the broker's TP identical
  // within the actual instrument digit. Never silently accept a TP change.
  if(Math.abs(bt-tp)>tick/2) return reject;
  const isBuy=i.direction==='BUY';
  const correctOriginal=isBuy?a<e-tick/2&&tp>e+tick/2:
    a>e+tick/2&&tp<e-tick/2;
  if(!correctOriginal) return reject;
  // Broker already has a stop beyond entry, strictly better than the
  // original risk SL, and at least two ticks away from current mark.
  const validTightening=isBuy
    ?bs>Math.max(a,e)+tick/2&&bs<m-2*tick&&m<tp+tick
    :bs<Math.min(a,e)-tick/2&&bs>m+2*tick&&m>tp-tick;
  if(!validTightening) return reject;
  return {
    preserveMoreProtectiveBrokerStop:true,
    reason:'MORE_PROTECTIVE_PROFIT_STOP_PENDING_AUTHORITY_SYNC',
    noOrderAction:true,
    needsAuthoritativeReconciliation:true,
  };
}
