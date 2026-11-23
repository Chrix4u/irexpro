import { DemoProtectedProfitRunnerOrchestrator, type OwnerDemoStopCandidate } from './demo-protected-profit-runner-orchestrator.service';
import { DataSource } from 'typeorm';
import { BrokerService } from '../../broker/broker.service';
import { DemoProfitStopAuthoritySyncService } from './demo-profit-stop-authority-sync.service';

const candidate:OwnerDemoStopCandidate={
  userId:'owner-1',brokerConnectionId:'9a14f702-4f46-42d1-9aee-eb282b3f5321',
  tradeId:'8a5b3a6b-5954-4505-90ee-b13873ac1945',
  brokerPositionId:'position-123',instrument:'USDJPY',direction:'SELL',
  strategyRoute:'EARLY_TRANSITION',tradeLots:'0.1000',entryPrice:'159.072',
  originalStop:'159.119',originalTakeProfit:'158.989',
  proposedPositiveStop:'159.060',estimatedExitCostReserve:'1',
  estimatedNetFloorAfterReserve:'4',
};
const position={externalOrderId:candidate.brokerPositionId,instrument:'USDJPY',direction:'SELL',
  lotSize:'0.1000',openPrice:'159.072',currentPrice:'159.043',
  stopLoss:'159.119',takeProfit:'158.989',unrealisedPnl:'16',
  openedAt:new Date(),commission:'-1',swap:'0'};
const mk=({accountType='DEMO',brokerId='pepperstone-ctrader',
  reserve=true,claim=true,cost='25',pos=position,callThrows=false,
  nativeMinUnit='POINTS'}:{accountType?:string,brokerId?:string,reserve?:boolean,
  claim?:boolean,cost?:string,pos?:typeof position|null,
  callThrows?:boolean,nativeMinUnit?:'POINTS'|'PERCENTAGE'|string}={})=>{
  const query=jest.fn(async (sql:string)=>{
    if(sql.includes('SELECT t.id,t.lot_size'))return [{initial_risk_pnl:cost}];
    if(sql.includes('INSERT INTO trading.demo_profit_stop_amendment_intents'))
      return reserve?[{id:'new-ledger'}]:[];
    if(sql.includes("SET state='DISPATCHING'"))return claim?[{id:'new-ledger'}]:[];
    return [];
  });
  const brokerService={
    getOpenPositionsForConnection:jest.fn().mockResolvedValue({
      connection:{id:candidate.brokerConnectionId,userId:candidate.userId,
        brokerId,accountType,accountCurrency:'USD'},positions:pos?[pos]:[],
    }),
    getInstrumentSpecForConnection:jest.fn().mockResolvedValue({
      symbol:'USDJPY',digits:3,minStopLossDistance:'0',
      minStopLossDistanceUnit:nativeMinUnit,
      minLot:'0.01',maxLot:'100',lotStep:'0.01',contractSize:'100000',
    }),
    getCurrentPriceForConnection:jest.fn().mockImplementation(async()=>({
      instrument:'USDJPY',bid:'159.041',ask:'159.043',spread:'0.002',timestamp:new Date(),
    })),
    amendVerifiedOwnerDemoProfitStop:callThrows?
      jest.fn(async()=>{throw new Error('provider unknown')}):
      jest.fn().mockResolvedValue({brokerReadbackStop:'159.060',
        brokerReadbackTakeProfit:'158.989',executionAuthorityGranted:false}),
  };
  const authoritySync={commitVerifiedStop:jest.fn().mockResolvedValue({
    state:'AUTHORITY_COMMITTED',committedStop:'159.060'}),
  };
  const service=new DemoProtectedProfitRunnerOrchestrator(
    {query} as unknown as DataSource,
    brokerService as unknown as BrokerService,
    authoritySync as unknown as DemoProfitStopAuthoritySyncService,
  );
  return {service,query,brokerService,authoritySync};
};
describe('owner Pepperstone DEMO protected stop orchestration before any hold',()=>{
  const flag1=process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_EXECUTION;
  const flag2=process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND;
  const flag3=process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC;
  const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
  beforeEach(()=>{
    process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_EXECUTION='enabled';
    process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND='enabled';
    process.env.IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC='enabled';
    process.env.VPS_FOREX_SCANNER_USER_ID='owner-1';
  });
  afterAll(()=>{
    for(const [key,value] of [
      ['IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_EXECUTION',flag1],
      ['IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_AMEND',flag2],
      ['IREXPRO_PEPPERSTONE_DEMO_STOP_AUTHORITY_SYNC',flag3],
      ['VPS_FOREX_SCANNER_USER_ID',owner],
    ] as Array<[string,string|undefined]>){if(value===undefined)delete process.env[key];else process.env[key]=value}
  });
  it('is disabled unless all THREE opt-in flags are enabled',async()=>{
    delete process.env.IREXPRO_PEPPERSTONE_DEMO_PROTECTED_RUNNER_EXECUTION;
    const h=mk();expect(await h.service.prepareAndCommitVerifiedPositiveStop(candidate))
      .toMatchObject({status:'DISABLED',permitsProfitCloseDeferral:false,permitsLiveOrders:false});
    expect(h.brokerService.getOpenPositionsForConnection).not.toHaveBeenCalled();
  });
  it('rejects LIVE mode without reserving a ledger or asking broker to amend',async()=>{
    const h=mk({accountType:'LIVE'});
    expect((await h.service.prepareAndCommitVerifiedPositiveStop(candidate)).status).toBe('INELIGIBLE');
    expect(h.query).not.toHaveBeenCalled();
    expect(h.brokerService.amendVerifiedOwnerDemoProfitStop).not.toHaveBeenCalled();
  });
  it('rejects different owner and wrong broker without provider writes',async()=>{
    const a=mk(); expect((await a.service.prepareAndCommitVerifiedPositiveStop({...candidate,userId:'another'})).status).toBe('INELIGIBLE');
    const b=mk({brokerId:'ctrader'});expect((await b.service.prepareAndCommitVerifiedPositiveStop(candidate)).status).toBe('INELIGIBLE');
    expect(b.brokerService.amendVerifiedOwnerDemoProfitStop).not.toHaveBeenCalled();
  });
  it('rejects mismatched position and unavailable native min-stop without amendment',async()=>{
    const a=mk({pos:{...position,stopLoss:'159.060'}});
    expect((await a.service.prepareAndCommitVerifiedPositiveStop(candidate)).status).toBe('INELIGIBLE');
    const b=mk({nativeMinUnit:'PERCENTAGE'});
    expect((await b.service.prepareAndCommitVerifiedPositiveStop(candidate)).status).toBe('INELIGIBLE');
    expect(b.brokerService.amendVerifiedOwnerDemoProfitStop).not.toHaveBeenCalled();
  });
  it('requires a fee-aware net stop floor supported by the original stop geometry',async()=>{
    const h=mk({cost:'1'});
    expect((await h.service.prepareAndCommitVerifiedPositiveStop(candidate)).status).toBe('INELIGIBLE');
    expect(h.query.mock.calls.some(x=>String(x[0]).includes('INSERT INTO trading'))).toBe(false);
  });
  it('never retries a duplicate or ambiguous ledger reservation',async()=>{
    const h=mk({reserve:false});
    expect((await h.service.prepareAndCommitVerifiedPositiveStop(candidate)).status).toBe('INELIGIBLE');
    expect(h.brokerService.amendVerifiedOwnerDemoProfitStop).not.toHaveBeenCalled();
  });
  it('does not dispatch when PREPARED→DISPATCHING CAS fails',async()=>{
    const h=mk({claim:false});
    expect((await h.service.prepareAndCommitVerifiedPositiveStop(candidate)).status).toBe('UNRESOLVED');
    expect(h.brokerService.amendVerifiedOwnerDemoProfitStop).not.toHaveBeenCalled();
  });
  it('commits a provider-acknowledged verified stop but NEVER grants hold authority',async()=>{
    const h=mk();const r=await h.service.prepareAndCommitVerifiedPositiveStop(candidate);
    expect(r).toEqual({status:'PREPARED_AND_BROKER_VERIFIED',ledgerId:'new-ledger',
      reason:'STOP_ACK_READBACK_AND_TRADE_AUTHORITY_COMMITTED',
      permitsProfitCloseDeferral:false,permitsLiveOrders:false});
    expect(h.brokerService.amendVerifiedOwnerDemoProfitStop).toHaveBeenCalledTimes(1);
    expect(h.authoritySync.commitVerifiedStop).toHaveBeenCalledWith('owner-1','new-ledger');
  });
  it('returns UNRESOLVED rather than holding on an ambiguous provider amendment',async()=>{
    const h=mk({callThrows:true});
    expect((await h.service.prepareAndCommitVerifiedPositiveStop(candidate)).status).toBe('UNRESOLVED');
    expect(h.brokerService.amendVerifiedOwnerDemoProfitStop).toHaveBeenCalledTimes(1);
    expect(h.authoritySync.commitVerifiedStop).not.toHaveBeenCalled();
  });
});
