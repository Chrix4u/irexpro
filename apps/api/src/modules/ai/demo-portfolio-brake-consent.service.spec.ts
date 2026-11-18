import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import {
  DemoPortfolioBrakeConsentService,
  isAuthorizedBrakeIncident,
} from './demo-portfolio-brake-consent.service';
import type { M1PortfolioNetLossBrakeDecision } from './m1-portfolio-net-loss-brake';

const OWNER = 'f22b66cb-188e-43db-8ded-ec8e85cc46ab';
const SESSION = '60a03a2a-337d-4c30-b952-8d106fe97104';
const BROKER = 'b61f871a-786c-43b2-a9ab-e9534b63b0c1';
const CLOSE = '2026-11-18T12:05:33.982Z';
const AT = new Date('2026-11-18T13:30:00.000Z');
const brake = (value: Partial<M1PortfolioNetLossBrakeDecision> = {}):
  M1PortfolioNetLossBrakeDecision => ({
    artifact:'m1-portfolio-net-loss-brake-v1',
    active:true,reason:'RECENT_PORTFOLIO_NET_LOSS_STREAK',
    recentClosedTrades:3,consecutiveNetLosses:3,
    latestClosedAt:new Date(CLOSE),
    cooldownMinutes:120,cooldownRemainingSeconds:2134,
    ...value,
  });
const trades = [
  { closed_at:CLOSE,instrument:'AUDUSD',direction:'SELL',
    realised_pnl:'-71.20',commission:'-10.68',swap:'0' },
  { closed_at:'2026-11-18T09:43:07Z',instrument:'USDJPY',direction:'BUY',
    realised_pnl:'-27.96',commission:'-10',swap:'0' },
  { closed_at:'2026-11-18T09:37:22Z',instrument:'AUDUSD',direction:'SELL',
    realised_pnl:'-29.26',commission:'-10',swap:'0' },
];
function setup(decision: 'RESUME'|'KEEP_PAUSED'|null=null) {
  const events:Array<{decision:string,expires_at:string}> = [];
  if (decision) events.push({decision,expires_at:'2026-11-18T14:05:33.982Z'});
  const query = jest.fn().mockImplementation(async (sql:string, params:unknown[])=>{
    if (sql.includes('FROM trading.trading_sessions s') &&
        sql.includes('s.status')) return [{session_id:SESSION,broker_connection_id:BROKER}];
    if (sql.includes('FROM trading.demo_portfolio_brake_consents c'))
      return events.length?[events.at(-1)]:[];
    if (sql.includes('FROM trading.trades t')) return trades;
    if (sql.includes('INSERT INTO trading.demo_portfolio_brake_consents')) {
      events.push({decision:params[4] as string,expires_at:params[8] as string});
      return [];
    }
    throw Error('Unexpected query '+sql.slice(0,80));
  });
  const config = {get: (_:string)=>OWNER} as ConfigService;
  const evidence = {
    loadPortfolioNetLossStreakBrake: jest.fn().mockResolvedValue(brake()),
  } as unknown as M1TacticalEvidenceService;
  const service = new DemoPortfolioBrakeConsentService(
    {query} as unknown as DataSource,config,evidence);
  return {service,query,evidence,events};
}
describe('owner-controlled current-DEMO portfolio loss-streak pause',()=>{
  beforeEach(() => { jest.useFakeTimers({now:new Date('2026-11-18T13:30:00Z')}); });
  afterEach(() => jest.useRealTimers());
  it('requires current matching incident, broker/account verification and explicit consent',async()=>{
    const {service,events}=setup();
    await expect(service.decide(OWNER,{
      action:'RESUME',acknowledged:false,incidentClosedAt:CLOSE,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.decide(OWNER,{
      action:'RESUME',acknowledged:true,incidentClosedAt:'2026-11-18T12:00:00.000Z',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(events).toHaveLength(0);
  });

  it('cannot alter another user or a LIVE/non-DEMO connection',async()=>{
    const {service,query}=setup();
    await expect(service.decide('unrelated-user',{
      action:'RESUME',acknowledged:true,incidentClosedAt:CLOSE,
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO'))).toBe(false);
    const r=await service.getStatus('unrelated-user',AT);
    expect(r.supported).toBe(false);
    expect(r.canOverrideCurrentIncident).toBe(false);
  });

  it('shows the three signed net losses and actual two-hour end',async()=>{
    const {service}=setup();
    const r=await service.getStatus(OWNER,AT);
    expect(r.state).toBe('PAUSED');
    expect(r.requiresOwnerDecision).toBe(true);
    expect(r.incidentClosedAt).toBe(CLOSE);
    expect(r.brakeExpiresAt).toBe('2026-11-18T14:05:33.982Z');
    expect(r.lastThreeNetUsd).toBe(-159.1);
    expect(r.recentLosses).toHaveLength(3);
    expect(r.brokerAccountType).toBe('DEMO');
    expect(r.otherRiskChecksRemainActive).toBe(true);
  });

  it('records the owners WAIT decision, persists and permits later RESUME',async()=>{
    const {service,events,query}=setup();
    await expect(service.decide(OWNER,{
      action:'KEEP_PAUSED',acknowledged:false,incidentClosedAt:CLOSE,
    })).resolves.toMatchObject({state:'WAITING',resumeAuthorized:false});
    await expect(service.decide(OWNER,{
      action:'RESUME',acknowledged:true,incidentClosedAt:CLOSE,
    })).resolves.toMatchObject({state:'OVERRIDDEN',resumeAuthorized:true});
    expect(events.map(x=>x.decision)).toEqual(['KEEP_PAUSED','RESUME']);
    expect(query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO'))).toHaveLength(2);
  });

  it('revokes consent on KEEP_PAUSED and does not preserve a stale approval',async()=>{
    const {service}=setup('RESUME');
    const approved=await service.isOverrideActive({
      userId:OWNER, brokerConnectionId:BROKER,sessionId:SESSION,
      latestClosedAt:new Date(CLOSE),evaluatedAt:AT,
    });
    expect(approved).toBe(true);
    const rejected=await service.isOverrideActive({
      userId:OWNER,brokerConnectionId:BROKER,sessionId:SESSION,
      latestClosedAt:new Date('2026-11-18T13:00:00Z'),evaluatedAt:AT,
    });
    expect(rejected).toBe(false);
    await service.decide(OWNER,{
      action:'KEEP_PAUSED',acknowledged:false,incidentClosedAt:CLOSE,
    });
    expect(await service.isOverrideActive({
      userId:OWNER,brokerConnectionId:BROKER,sessionId:SESSION,
      latestClosedAt:new Date(CLOSE),evaluatedAt:AT,
    })).toBe(false);
  });

  it('approved risk exception never waives unverified risk evidence',()=>{
    const accepted={decision:'RESUME',expires_at:'2026-11-18T14:05:33.982Z'};
    expect(isAuthorizedBrakeIncident(brake(),accepted,AT)).toBe(true);
    expect(isAuthorizedBrakeIncident(brake({active:false}),accepted,AT)).toBe(false);
    expect(isAuthorizedBrakeIncident(brake({
      reason:'COST_OR_CURRENCY_UNVERIFIED'}),accepted,AT)).toBe(false);
    expect(isAuthorizedBrakeIncident(brake(),{
      ...accepted,expires_at:'2026-11-18T17:00:00Z'},AT)).toBe(false);
    expect(isAuthorizedBrakeIncident(brake(),accepted,
      new Date('2026-11-18T14:06:00Z'))).toBe(false);
  });
});
