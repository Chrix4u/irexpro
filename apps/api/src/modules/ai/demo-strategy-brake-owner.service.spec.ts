import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import {
  DemoStrategyBrakeOwnerService,
  STRATEGY_BRAKE_SQL,
  validLimitedRecoveryConsent,
  DEMO_STRATEGY_RECOVERY_LOT_CAP,
} from './demo-strategy-brake-owner.service';

const OWNER='fbf0cacb-c1be-4cd9-818d-7648b503ebef';
const SESSION='a6e9478b-0f1b-41cf-933b-e918280d81bd';
const BROKER='e88f4d21-480b-4f98-916b-a7209d37f00b';
const CLOSED='2026-11-18T14:22:47.343Z';
const AT=new Date('2026-11-18T22:30:00Z');
const row={
  evaluated_at:'2026-11-18T20:59:00Z',
  instrument:'USDJPY',direction:'SELL',strategy:'CONFIRMED_REVERSAL',
  brake:{active:true,reason:'PERSISTENT_NEGATIVE_PAYOFF',
    latestClosedAt:CLOSED,cooldownRemainingSeconds:19428,
    persistentNegativePayoff:true,profitFactor:.4895,payoffClosedTrades:8,
    recentWins:2,recentLosses:0},
};
const input={
  action:'RESUME_LIMITED' as const,acknowledged:true,
  route:'CONFIRMED_REVERSAL' as const,
  instrument:'USDJPY',direction:'SELL' as const,incidentClosedAt:CLOSED,
};
function setup(opts:{otherOwner?:boolean;decision?:'RESUME_LIMITED'|'KEEP_PAUSED';used?:number}={}){
  let decision=opts.decision??null;
  const events:{sql:string;params:unknown[]}[]=[];
  const consentAt='2026-11-18T22:30:00Z';
  const query=jest.fn().mockImplementation(async(sql:string,params:unknown[])=>{
    events.push({sql,params});
    if(sql.includes('FROM trading.trading_sessions s'))return [{
      session_id:SESSION,broker_connection_id:BROKER,
    }];
    if(sql===STRATEGY_BRAKE_SQL)return [row];
    if(sql.includes('SELECT decision,brake_reason,created_at,expires_at FROM trading.demo_strategy_brake_owner_decisions'))
      return decision?[{decision,brake_reason:'PERSISTENT_NEGATIVE_PAYOFF',created_at:consentAt,expires_at:'2026-11-18T23:30:00Z'}]:[];
    if(sql.includes('SELECT COUNT(*)::int n FROM trading.trade_intents'))return [{n:opts.used??0}];
    if(sql.includes('INSERT INTO trading.demo_strategy_brake_owner_decisions')){
      decision=params[8] as 'KEEP_PAUSED'|'RESUME_LIMITED';return [];
    }
    throw Error('Unexpected query: '+sql.slice(0,90));
  });
  const config={get:()=>OWNER} as unknown as ConfigService;
  const evidence={loadMultimodelLossStreakBrake:jest.fn().mockResolvedValue({
    active:true,reason:'PERSISTENT_NEGATIVE_PAYOFF',latestClosedAt:new Date(CLOSED),
  })} as unknown as M1TacticalEvidenceService;
  return {
    service:new DemoStrategyBrakeOwnerService(
      {query} as unknown as DataSource,config,evidence),
    query,events,evidence,
  };
}
describe('owner DEMO strategy-level risk modal and one-entry recovery',()=>{
  beforeEach(()=>jest.useFakeTimers({now:AT}));
  afterEach(()=>jest.useRealTimers());
  it('does not expose incidents or decisions to unrelated accounts',async()=>{
    const {service,query}=setup();
    const status=await service.getStatus('unauthorized');
    expect(status.supported).toBe(false);
    expect(query).not.toHaveBeenCalled();
    await expect(service.decide('unauthorized',input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO'))).toBe(false);
  });
  it('displays exact strategy, side, historical risk and distinct decision need',async()=>{
    const {service}=setup();
    const status=await service.getStatus(OWNER,AT);
    expect(status.active).toBe(true);
    expect(status.incidents).toHaveLength(1);
    expect(status.incidents[0]).toMatchObject({
      instrument:'USDJPY',direction:'SELL',route:'CONFIRMED_REVERSAL',
      reason:'PERSISTENT_NEGATIVE_PAYOFF',profitFactor:.4895,
      requiresOwnerDecision:true,recoveryLotCap:1,maxRecoveryEntries:1,
    });
    expect(status.otherModelAndBrokerRiskChecksRemainActive).toBe(true);
    expect(status.overridesHardAccountOrBrokerRisk).toBe(false);
  });
  it('requires explicit risk acknowledgment and exact incident',async()=>{
    const {service,events}=setup();
    await expect(service.decide(OWNER,{...input,acknowledged:false}))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.decide(OWNER,{...input,incidentClosedAt:'2026-11-18T13:00:00.000Z'}))
      .rejects.toThrow();
    expect(events.some(e=>e.sql.includes('INSERT INTO'))).toBe(false);
  });
  it('the owner may keep pause or explicitly approve a single limited recovery',async()=>{
    const {service,events}=setup();
    await expect(service.decide(OWNER,{...input,action:'KEEP_PAUSED',acknowledged:false}))
      .resolves.toMatchObject({active:true});
    await expect(service.decide(OWNER,input)).resolves.toMatchObject({active:true});
    expect(events.filter(e=>e.sql.includes('INSERT INTO')).map(e=>e.params[8]))
      .toEqual(['KEEP_PAUSED','RESUME_LIMITED']);
    expect(DEMO_STRATEGY_RECOVERY_LOT_CAP).toBe(1);
  });
  it('approval is incident-bound, time-bounded and strictly one entry',()=>{
    const consent={
      decision:'RESUME_LIMITED' as const,
      brake_reason:'PERSISTENT_NEGATIVE_PAYOFF',
      created_at:'2026-11-18T22:30:00Z',
      expires_at:'2026-11-18T23:30:00Z',
    };
    expect(validLimitedRecoveryConsent(CLOSED,consent,new Date('2026-11-18T22:31:00Z'),0)).toBe(true);
    expect(validLimitedRecoveryConsent(CLOSED,consent,new Date('2026-11-18T22:31:00Z'),1)).toBe(false);
    expect(validLimitedRecoveryConsent(CLOSED,consent,new Date('2026-11-18T23:30:01Z'),0)).toBe(false);
    expect(validLimitedRecoveryConsent('2026-11-18T22:32:00Z',consent,new Date('2026-11-18T22:33:00Z'),0)).toBe(false);
  });
  it('requires matching broker, session, route, pair and side',async()=>{
    const {service}=setup({decision:'RESUME_LIMITED'});
    expect(await service.isRecoveryApproved({
      userId:OWNER,brokerConnectionId:BROKER,sessionId:SESSION,
      route:'CONFIRMED_REVERSAL',instrument:'USDJPY',direction:'SELL',
      reason:'PERSISTENT_NEGATIVE_PAYOFF',latestClosedAt:new Date(CLOSED),at:new Date('2026-11-18T22:40:00Z'),
    })).toBe(true);
    expect(await service.isRecoveryApproved({
      userId:OWNER,brokerConnectionId:BROKER,sessionId:'wrong',
      route:'CONFIRMED_REVERSAL',instrument:'USDJPY',direction:'SELL',
      reason:'PERSISTENT_NEGATIVE_PAYOFF',latestClosedAt:new Date(CLOSED),at:new Date('2026-11-18T22:40:00Z'),
    })).toBe(false);
  });
  it('rejects later order after consent already consumed',async()=>{
    const {service}=setup({decision:'RESUME_LIMITED',used:1});
    expect(await service.isRecoveryApproved({
      userId:OWNER,brokerConnectionId:BROKER,sessionId:SESSION,
      route:'CONFIRMED_REVERSAL',instrument:'USDJPY',direction:'SELL',
      reason:'PERSISTENT_NEGATIVE_PAYOFF',latestClosedAt:new Date(CLOSED),at:new Date('2026-11-18T22:40:00Z'),
    })).toBe(false);
  });
});
