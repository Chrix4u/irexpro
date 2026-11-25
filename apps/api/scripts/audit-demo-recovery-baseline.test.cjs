const test=require('node:test');
const assert=require('node:assert/strict');
const {finiteMoney,tradeNet,groupTrades,compareFunnel,buildRouteEconomics}=
  require('./audit-demo-recovery-baseline.cjs');
const trade=(gross,commission,swap='0',date='2026-11-11T10:00:00Z')=>({
  realised_pnl:gross,commission,swap,created_at:date,
});
test('counts net after real commission and swap, not displayed gross',()=>{
  assert.equal(tradeNet(trade('328','-24')),304);
  assert.equal(tradeNet(trade('-116','-24')),-140);
  assert.equal(tradeNet(trade('10',null)),null);
});
test('broker trading baseline aggregates actual net and drawdown',()=>{
  const r=groupTrades([trade('328','-24'),trade('-116','-24'),
    trade('52','-24'),trade('162','-12')]);
  assert.deepEqual({
    deals:r.deals,wins:r.winners,losses:r.losers,net:r.net,
    fees:r.netFees,profitFactor:r.netProfitFactor,
    maxClosedTradeDrawdown:r.maxClosedTradeDrawdown,
  },{
    deals:4,wins:3,losses:1,net:342,
    fees:-84,profitFactor:3.443,maxClosedTradeDrawdown:140,
  });
  assert.equal(r.eligibleForAutomaticPromotion,false);
});
test('missing fees make completeness fail and cannot masquerade as wins',()=>{
  const r=groupTrades([trade('328','-24'),trade('42',null)]);
  assert.equal(r.deals,2);
  assert.equal(r.completeFeeDeals,1);
  assert.equal(r.incompleteFeeDeals,1);
  assert.equal(r.net,304);
  assert.equal(r.eligibleForAutomaticPromotion,false);
});
test('Plan B paper and M1 route are independent sets, not multiple approvals',()=>{
  const r=compareFunnel([{
    utc_day:'2026-11-11',instrument:'AUDUSD',scans:100,
    m1_routed:20,planb_paper_admitted:15,route_overlap:3,
    broker_authorized:1,
  }]);
  assert.deepEqual(r['2026-11-11:AUDUSD'],{
    scans:100,m1Routed:20,planBPaperAdmitted:15,eligibleOverlap:3,
    planBOnly:12,m1Only:17,brokerAuthorized:1,
    overlapRateOfScans:0.03,admissionIsNotBrokerExecution:true,
  });
});
test('invalid disagreement funnel fails instead of fabricating counts',()=>{
  assert.throws(()=>compareFunnel([{
    utc_day:'2026-11-11',instrument:'AUDUSD',scans:10,
    m1_routed:2,planb_paper_admitted:2,route_overlap:4,
    broker_authorized:0,
  }]),/Invalid decision funnel/);
});
test('money parser rejects invalid nonnumeric data',()=>{
  assert.equal(finiteMoney(''),null);
  assert.equal(finiteMoney('NaN'),null);
  assert.equal(finiteMoney('10.15'),10.15);
});


test('isolates actual PRIMARY route economics without averaging reversals with continuations',()=>{
  const trades=[
    {...trade('328','-24', '0', '2026-11-11T07:45:00Z'),
      route:'M1_TREND_CONTINUATION',utc_day:'2026-11-11'},
    {...trade('-116','-24', '0', '2026-11-11T09:47:00Z'),
      route:'M1_TREND_CONTINUATION',utc_day:'2026-11-11'},
    {...trade('156','-12', '0', '2026-11-11T13:14:00Z'),
      route:'M1_TREND_CONTINUATION',utc_day:'2026-11-11'},
    {...trade('328','-24', '0', '2026-11-11T02:08:00Z'),
      route:'M1_EARLY_TRANSITION',utc_day:'2026-11-11'},
  ];
  const r=buildRouteEconomics(trades,['2026-11-11']);
  assert.equal(r.routeAfterFeeEconomics['M1_TREND_CONTINUATION'].net,308);
  assert.equal(r.routeAfterFeeEconomics['M1_EARLY_TRANSITION'].net,304);
  assert.equal(
    r.routeAfterFeeByGhanaSession['M1_TREND_CONTINUATION:13_TO_23_UTC'].net,
    144,
  );
  assert.equal(
    r.routeAfterFeeByGhanaSession['M1_TREND_CONTINUATION:00_TO_12_UTC'].deals,
    2,
  );
  assert.equal(
    r.routeAfterFeeEconomics['M1_EARLY_TRANSITION'].eligibleForAutomaticPromotion,
    false,
  );
});
