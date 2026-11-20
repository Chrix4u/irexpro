import {
  ownerPepperstoneDemoOngoingSevenLot,
  OWNER_DEMO_ONGOING_SEVEN_LOT_ARTIFACT,
} from './owner-pepperstone-demo-ongoing-seven-lot';

const owner={
  enabled:true,userId:'owner',configuredOwnerId:'owner',
  brokerConnectionId:'pepperstone-usd-demo',
  configuredBrokerConnectionId:'pepperstone-usd-demo',
  brokerId:'pepperstone-ctrader',
  accountType:'DEMO',accountCurrency:'USD',
  now:new Date('2026-11-20T12:55:00.000Z'),
};
describe('ongoing owner Pepperstone DEMO 7-lot request ceiling',()=>{
  it('authorizes up to 7 requests without forcing 4/4.5/6/7 actual fills',()=>{
    const r=ownerPepperstoneDemoOngoingSevenLot(owner);
    expect(r.eligible).toBe(true);
    expect(r.maxRequestedLots).toBe(7);
    expect(r.maximumPrescreenRiskPercent).toBe(0.75);
    expect(r.endsAt).toBe(null);
    expect(r.artifact).toBe(OWNER_DEMO_ONGOING_SEVEN_LOT_ARTIFACT);
    expect(r.requiresActualBrokerRiskApproval).toBe(true);
    expect(r.noLiveAuthority).toBe(true);
  });
  it('does not inherit prior noon expiry nor authorize previous timestamps',()=>{
    const after=ownerPepperstoneDemoOngoingSevenLot({
      ...owner,now:new Date('2026-11-23T12:00:00Z')});
    expect(after.eligible).toBe(true);
    const before=ownerPepperstoneDemoOngoingSevenLot({
      ...owner,now:new Date('2026-11-20T12:49:59.999Z')});
    expect(before.eligible).toBe(false);
    expect(before.maxRequestedLots).toBe(4);
  });
  it.each([
    {enabled:false},
    {accountType:'LIVE'},
    {accountType:'PAPER'},
    {brokerId:'icmarkets-ctrader'},
    {accountCurrency:'EUR'},
    {brokerConnectionId:'other'},
    {configuredBrokerConnectionId:''},
    {userId:'another'},
    {configuredOwnerId:null},
    {now:new Date(NaN)},
  ])('is strictly fail-closed for mismatch %o',(override)=>{
    const r=ownerPepperstoneDemoOngoingSevenLot({...owner,...override});
    expect(r.eligible).toBe(false);
    expect(r.maxRequestedLots).toBe(4);
    expect(r.maximumPrescreenRiskPercent).toBe(0.25);
    expect(r.artifact).toBe(null);
  });
});
