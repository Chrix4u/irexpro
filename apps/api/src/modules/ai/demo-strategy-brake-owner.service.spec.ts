import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import {
 DemoStrategyBrakeOwnerService, STRATEGY_BRAKE_SQL, validContinuedTradingConsent,
} from './demo-strategy-brake-owner.service';

const OWNER='fbf0cacb-c1be-4cd9-818d-7648b503ebef';
const SESSION='a6e9478b-0f1b-41cf-933b-e918280d81bd';
const BROKER='e88f4d21-480b-4f98-916b-a7209d37f00b';
const CLOSED='2026-11-18T14:22:47.343Z';
const AT=new Date('2026-11-18T22:30:00Z');
const row={
 evaluated_at:'2026-11-18T20:59:00Z',instrument:'USDJPY',direction:'SELL',
 strategy:'CONFIRMED_REVERSAL',
 brake:{active:true,reason:'PERSISTENT_NEGATIVE_PAYOFF',
   latestClosedAt:CLOSED,cooldownRemainingSeconds:19428,
   persistentNegativePayoff:true,profitFactor:.4895,payoffClosedTrades:8,
   recentWins:2,recentLosses:0},
};
const input={
 action:'CONTINUE_TRADING' as const,route:'CONFIRMED_REVERSAL' as const,
 instrument:'USDJPY',direction:'SELL' as const,incidentClosedAt:CLOSED,
};
function setup(opts:{decision?:'CONTINUE_TRADING'|'KEEP_PAUSED'|'RESUME_LIMITED';
 reason?:string;denySession?:boolean}={}){
 let decision=opts.decision??null;
 const events:{sql:string;params:unknown[]}[]=[];
 const query=jest.fn().mockImplementation(async(sql:string,params:unknown[])=>{
  events.push({sql,params});
  if(sql.includes('FROM trading.trading_sessions s'))
   return opts.denySession?[]:[{session_id:SESSION,broker_connection_id:BROKER}];
  if(sql===STRATEGY_BRAKE_SQL)return [row];
  if(sql.includes('SELECT decision,created_at FROM trading.demo_strategy_brake_owner_decisions'))
   return params[0]===OWNER&&params[1]===BROKER&&
      params[2]==='CONFIRMED_REVERSAL'&&params[3]==='USDJPY'&&params[4]==='SELL'&&decision?
      [{decision,created_at:'2026-11-18T22:30:00Z'}]:[];
  if(sql.includes('INSERT INTO trading.demo_strategy_brake_owner_decisions')){
   decision=params[8] as 'CONTINUE_TRADING'|'KEEP_PAUSED';return [];
  }
  throw Error('Unexpected SQL '+sql.slice(0,100));
 });
 const config={get:()=>OWNER} as unknown as ConfigService;
 const evidence={loadMultimodelLossStreakBrake:jest.fn().mockResolvedValue({
  active:true,reason:opts.reason??'PERSISTENT_NEGATIVE_PAYOFF',
  latestClosedAt:new Date(CLOSED),
 })} as unknown as M1TacticalEvidenceService;
 return {service:new DemoStrategyBrakeOwnerService({query} as unknown as DataSource,
   config,evidence),events,query};
}
const check=(service:DemoStrategyBrakeOwnerService,extra:Record<string,unknown>={})=>
 service.isContinuationApproved({
  userId:OWNER,brokerConnectionId:BROKER,sessionId:SESSION,
  route:'CONFIRMED_REVERSAL',instrument:'USDJPY',direction:'SELL',
  reason:'PERSISTENT_NEGATIVE_PAYOFF',latestClosedAt:new Date(CLOSED),
  at:new Date('2026-11-18T22:40:00Z'),...extra,
 });
describe('Owner controlled DEMO strategy loss pause: Keep Paused / Continue Trading',()=>{
 beforeEach(()=>jest.useFakeTimers({now:AT}));
 afterEach(()=>jest.useRealTimers());
 it('rejects non-owner accounts without querying broker data',async()=>{
  const {service,query}=setup();
  expect((await service.getStatus('intruder')).supported).toBe(false);
  await expect(service.decide('intruder',input)).rejects.toBeInstanceOf(ForbiddenException);
  expect(query).not.toHaveBeenCalled();
 });
 it('shows exact strategy, instrument and direction to the owner',async()=>{
  const {service}=setup();
  const x=await service.getStatus(OWNER,AT);
  expect(x.active).toBe(true);
  expect(x.incidents).toHaveLength(1);
  expect(x.incidents[0]).toMatchObject({
   route:'CONFIRMED_REVERSAL',instrument:'USDJPY',direction:'SELL',
   profitFactor:.4895,requiresOwnerDecision:true,
   continueTradingAuthorized:false,
  });
 });
 it('accepts only the selected current broker incident',async()=>{
  const {service,events}=setup();
  await expect(service.decide(OWNER,{
   ...input,incidentClosedAt:'2026-11-18T10:00:00.000Z',
  })).rejects.toBeInstanceOf(NotFoundException);
  expect(events.some(x=>x.sql.startsWith('INSERT INTO'))).toBe(false);
 });
 it('owner can choose Keep Paused then Continue Trading, no checkbox or expiry',async()=>{
  const {service,events}=setup();
  await service.decide(OWNER,{...input,action:'KEEP_PAUSED'});
  const status=await service.decide(OWNER,input);
  const inserts=events.filter(x=>x.sql.includes('INSERT INTO'));
  expect(inserts.map(x=>x.params[8])).toEqual(['KEEP_PAUSED','CONTINUE_TRADING']);
  expect(inserts[1].params[9]).toBe(false);
  expect(inserts[1].params[10]).toBe(null);
  expect(status.incidents[0].continueTradingAuthorized).toBe(true);
  expect(status.incidents[0].requiresOwnerDecision).toBe(false);
 });
 it('approval has no one-hour timer or one-trade budget',()=>{
  const value={decision:'CONTINUE_TRADING' as const,created_at:'2026-11-18T22:30:00Z'};
  expect(validContinuedTradingConsent(value,new Date('2026-11-19T12:00:00Z'))).toBe(true);
  expect(validContinuedTradingConsent(value,new Date('2026-11-18T22:29:59Z'))).toBe(false);
  expect(validContinuedTradingConsent({decision:'KEEP_PAUSED',created_at:value.created_at},
    new Date('2026-11-19T12:00:00Z'))).toBe(false);
  expect(validContinuedTradingConsent({decision:'RESUME_LIMITED',created_at:value.created_at},
    new Date('2026-11-19T12:00:00Z'))).toBe(false);
 });
 it('continuation is session, owner, broker, pair, strategy and side scoped',async()=>{
  const {service}=setup({decision:'CONTINUE_TRADING'});
  expect(await check(service)).toBe(true);
  expect(await check(service,{sessionId:'different'})).toBe(false);
  expect(await check(service,{instrument:'EURUSD'})).toBe(false);
  expect(await check(service,{direction:'BUY'})).toBe(false);
  expect(await check(service,{route:'EARLY_TRANSITION'})).toBe(false);
  expect(await check(service,{brokerConnectionId:'different'})).toBe(false);
 });
 it('Keep Paused denies continuation for the same owner',async()=>{
  expect(await check(setup({decision:'KEEP_PAUSED'}).service)).toBe(false);
 });
 it('legacy one-entry consent cannot authorize normal continuation',async()=>{
  expect(await check(setup({decision:'RESUME_LIMITED'}).service)).toBe(false);
 });
 it('does not mistake owner permission for an automatic broker order',async()=>{
  const {service,events}=setup({decision:'CONTINUE_TRADING'});
  expect(await check(service)).toBe(true);
  expect(events.every(x=>!x.sql.includes('INSERT INTO trading.trade_intents'))).toBe(true);
 });
});
