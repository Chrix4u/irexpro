'use strict';

/**
 * Retrospective broker-price STOP audit, NOT a forward entry or exit model.
 * Price labels use the original confirmed fill and protective stop.
 * A recovery after a stop is not proof that a wider stop would have survived,
 * nor that holding the position would have improved net P&L.
 */
const HORIZONS = Object.freeze([1, 3, 5, 10]);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function classifyClosedStopTrade(trade, horizonMarks) {
  if (!trade || trade.status !== 'CLOSED' || !trade.closed_at ||
      trade.account_currency !== 'USD' ||
      !['BUY','SELL'].includes(trade.direction)) {
    return {state:'OUT_OF_SCOPE', reason:'CLOSED_OWNER_USD_DEMO_REQUIRED'};
  }
  const fill = finite(trade.fill_price);
  const stop = finite(trade.stop_loss);
  const exit = finite(trade.exit_price);
  const direction = trade.direction === 'BUY' ? 1 : -1;
  if (fill === null || stop === null || exit === null ||
      fill <= 0 || stop <= 0 || exit <= 0 ||
      direction*(fill-stop) <= 0) {
    return {state:'INCOMPLETE', reason:'MISSING_OR_INVALID_BROKER_FILL_STOP_EXIT'};
  }
  const riskPrice = Math.abs(fill-stop);
  const gross = finite(trade.realised_pnl);
  const commission = finite(trade.commission);
  const swap = finite(trade.swap);
  const settled = gross !== null && commission !== null && swap !== null;
  const net = settled ? gross+commission+swap : null;
  const riskAmount = finite(trade.initial_risk);
  const maxFavorable = finite(trade.max_favorable_pnl);
  const peakR = maxFavorable !== null && riskAmount !== null && riskAmount > 0 ?
    maxFavorable/riskAmount : null;
  const profitThenNetLoss = settled && net < 0 &&
    maxFavorable !== null && maxFavorable > 0;
  const quoted = {};
  let available=0, bestPriceR=null, anyReclaim=false, anyBounce=false;
  for (const minutes of HORIZONS) {
    const mark=horizonMarks?.[minutes] ?? null;
    const bid=finite(mark?.bid),ask=finite(mark?.ask);
    // BUY can only close at bid; SELL can only close at ask.
    if (bid === null || ask === null || bid <= 0 || ask < bid) {
      quoted[minutes+'m'] = null; continue;
    }
    const price = direction===1 ? bid : ask;
    const fromFillR = direction*(price-fill)/riskPrice;
    const fromExitR = direction*(price-exit)/riskPrice;
    quoted[minutes+'m'] = {
      fromOriginalFillR:Number(fromFillR.toFixed(5)),
      fromActualExitR:Number(fromExitR.toFixed(5)),
      observedAt:mark.closedAtMs?new Date(mark.closedAtMs).toISOString():null,
    };
    available++;
    if(bestPriceR===null || fromFillR>bestPriceR)bestPriceR=fromFillR;
    if(fromFillR>=0.1)anyReclaim=true;
    if(fromExitR>0.1)anyBounce=true;
  }
  const closeReason = trade.close_reason || 'UNREPORTED';
  // Broker CLOSE does not prove the stop triggered, even if near the barrier.
  const confirmedStop = closeReason==='STOP_LOSS_HIT';
  const potentialStop = closeReason==='BROKER_CLOSE' &&
    Math.abs(exit-stop) <= 0.15*riskPrice;
  let state;
  if (confirmedStop) {
    state = available===0 ? 'STOP_FOLLOWUP_MISSING' :
      anyReclaim ? 'STOP_THEN_ENTRY_RECLAIMED' :
      anyBounce ? 'STOP_THEN_PARTIAL_BOUNCE' :
      'STOP_WITHOUT_OBSERVED_RECOVERY';
  } else if (potentialStop) state='BROKER_CLOSE_NEAR_STOP_UNCONFIRMED';
  else if (closeReason==='PROFIT_PROTECTION')state='PROFIT_PROTECTION_CLOSE';
  else if (closeReason==='TAKE_PROFIT_HIT')state='TAKE_PROFIT_CLOSE';
  else state='OTHER_BROKER_CLOSE';
  return {
    state,closeReason,confirmedStop,potentialStop,
    instrument:trade.instrument,direction:trade.direction,
    strategyRoute:trade.strategy_route ?? 'UNCLASSIFIED',
    openedAt:trade.opened_at,closedAt:trade.closed_at,
    lots:finite(trade.lot_size),
    entryPrice:fill,stopPrice:stop,exitPrice:exit,
    observedHorizonCount:available,
    postExitPricesInRiskUnits:quoted,
    maxObservedPostExitPriceR:bestPriceR,
    settled,netAfterCommissionAndSwap:net,
    commissionCharged:commission,swapCharged:swap,
    peakBrokerPnl:maxFavorable,peakRiskUnits:peakR,
    profitThenNetLoss,
    provenance:{
      source:'BROKER_NATIVE_M1_CLOSE_BID_ASK',
      classification:'RETROSPECTIVE_PRICE_ONLY',
      changesExecution:false,
      limitations:'End-of-minute prices cannot reconstruct intraminute extremes or prove that a wider stop would have survived. A return to the entry price does not guarantee after-fee recovery or a fill.',
    },
  };
}

function summarizeStopFollowups(rows) {
  const closed=rows.filter(x=>x.state!=='OUT_OF_SCOPE'&&x.state!=='INCOMPLETE');
  const byRoute={};
  for(const r of closed){
    const key=r.strategyRoute || 'UNCLASSIFIED';
    const s=byRoute[key] ||= {trades:0,confirmedStops:0,stopWithPriceReclaim:0,
      stopWithPartialBounce:0,stopWithoutObservedRecovery:0,
      stopNoFollowup:0,unconfirmedBrokerCloseNearStop:0,
      profitThenNetLoss:0,settled:0,netAfterFees:0};
    s.trades++;
    if(r.confirmedStop)s.confirmedStops++;
    if(r.state==='STOP_THEN_ENTRY_RECLAIMED')s.stopWithPriceReclaim++;
    if(r.state==='STOP_THEN_PARTIAL_BOUNCE')s.stopWithPartialBounce++;
    if(r.state==='STOP_WITHOUT_OBSERVED_RECOVERY')s.stopWithoutObservedRecovery++;
    if(r.state==='STOP_FOLLOWUP_MISSING')s.stopNoFollowup++;
    if(r.state==='BROKER_CLOSE_NEAR_STOP_UNCONFIRMED')s.unconfirmedBrokerCloseNearStop++;
    if(r.profitThenNetLoss)s.profitThenNetLoss++;
    if(r.settled){s.settled++;s.netAfterFees+=r.netAfterCommissionAndSwap;}
  }
  for(const v of Object.values(byRoute))v.netAfterFees=Number(v.netAfterFees.toFixed(2));
  return {
    artifact:'irexpro-owner-demo-post-stop-direction-audit-v1',
    researchOnly:true,modifiesExecution:false,
    evaluatedClosedTrades:closed.length,
    incompleteInputs:rows.length-closed.length,
    byStrategyRoute:byRoute,
  };
}
module.exports={HORIZONS,classifyClosedStopTrade,summarizeStopFollowups};
