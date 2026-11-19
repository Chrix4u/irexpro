import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';

const ROUTES = ['EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION'] as const;
const PAIRS = ['EURUSD','AUDUSD','USDJPY','USDCAD'] as const;
const WINDOW_MS = 6 * 3600000;
type Route = typeof ROUTES[number];
type Side = 'BUY' | 'SELL';
type Action = 'KEEP_PAUSED' | 'CONTINUE_TRADING';
type Session = {session_id:string;broker_connection_id:string};
type Brake = {active:boolean;reason:string;latestClosedAt:string|null;
 cooldownRemainingSeconds?:number;persistentNegativePayoff?:boolean;
 recentWins?:number;recentLosses?:number;profitFactor?:number|null;payoffClosedTrades?:number};
type Candidate = {evaluated_at:string|Date;instrument:string;direction:Side;strategy:Route;brake:Brake};
type Consent = {decision:Action|'RESUME_LIMITED';created_at:string|Date};
export interface StrategyBrakeIncident {
  id:string;route:Route;instrument:string;direction:Side;reason:string;
  latestBlockedAt:string;incidentClosedAt:string;
  cooldownRemainingSeconds:number;persistentNegativePayoff:boolean;
  payoffTrades:number;profitFactor:number|null;recentWins:number;recentLosses:number;
  userDecision:Action|null;continueTradingAuthorized:boolean;requiresOwnerDecision:boolean;
}
export interface StrategyBrakeOwnerStatus {
  supported:boolean;active:boolean;accountType:'DEMO'|null;currency:'USD'|null;
  incidents:StrategyBrakeIncident[];summary:string;
  otherModelAndBrokerRiskChecksRemainActive:true;
  overridesHardAccountOrBrokerRisk:false;noAutomaticSideReversal:true;
}
export const STRATEGY_BRAKE_SQL=[
  'SELECT d.evaluated_at,d.instrument,d.direction,',
  "d.governance->'multimodelEnsemble'->>'strategyRoute' strategy,",
  "d.governance->'multimodelLossStreakBrake' brake",
  'FROM trading.m1_tactical_decisions d',
  'JOIN broker.broker_connections b ON b.id=d.broker_connection_id AND b.user_id=d.user_id',
  'WHERE d.user_id=$1 AND b.user_id=$1 AND d.broker_connection_id=$2',
  "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
  "AND b.account_currency='USD' AND b.deleted_at IS NULL",
  'AND d.evaluated_at>=$3::timestamptz AND d.evaluated_at<=$4::timestamptz',
  "AND (d.governance->'demoAlternativeTrial'->>'eligible'='true' OR",
  "d.governance->'multimodelEnsemble'->>'strategyRoute'='TREND_CONTINUATION')",
  "AND d.governance->'multimodelLossStreakBrake'->>'active'='true'",
  "AND d.governance->'multimodelEnsemble'->>'strategyRoute' IN",
  "('EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION')",
  'ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 101',
].join(' ');
const CONSENT_SQL=[
 'SELECT decision,created_at FROM trading.demo_strategy_brake_owner_decisions',
 'WHERE user_id=$1 AND broker_connection_id=$2',
 'AND strategy_route=$3 AND instrument=$4 AND direction=$5',
 'ORDER BY created_at DESC,id DESC LIMIT 1',
].join(' ');
const iso=(date:string|Date)=>new Date(date).toISOString();
const n=(x:unknown)=>x===null||x===undefined||!Number.isFinite(Number(x))?0:Number(x);
function validCandidate(x:Candidate) {
 return ROUTES.includes(x.strategy) &&
   PAIRS.includes(x.instrument as typeof PAIRS[number]) &&
   (x.direction==='BUY'||x.direction==='SELL') &&
   x.brake?.active===true &&
   ['PERSISTENT_NEGATIVE_PAYOFF','RECENT_MULTIMODEL_LOSS_STREAK','RECENT_NEGATIVE_PAYOFF']
    .includes(x.brake.reason) &&
   typeof x.brake.latestClosedAt==='string' &&
   Number.isFinite(Date.parse(x.brake.latestClosedAt));
}
export function validContinuedTradingConsent(d:Consent|null,at:Date):boolean {
 if(!d||d.decision!=='CONTINUE_TRADING')return false;
 const issued=new Date(d.created_at).getTime();
 return Number.isFinite(issued)&&issued<=at.getTime();
}
@Injectable()
export class DemoStrategyBrakeOwnerService {
 constructor(
  private readonly db:DataSource,
  private readonly config:ConfigService,
  private readonly evidence:M1TacticalEvidenceService,
 ) {}
 private owner(id:string) {
  return Boolean(id&&this.config.get<string>('VPS_FOREX_SCANNER_USER_ID','')===id);
 }
 private async session(id:string):Promise<Session|null> {
  if(!this.owner(id))return null;
  const sql=[
   'SELECT s.id session_id,s.broker_connection_id FROM trading.trading_sessions s',
   'JOIN broker.broker_connections b ON b.id=s.broker_connection_id AND b.user_id=s.user_id',
   "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'",
   "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
   "AND b.account_currency='USD' AND b.deleted_at IS NULL",
   'ORDER BY s.started_at DESC LIMIT 1',
  ].join(' ');
  const rows=await this.db.query(sql,[id]) as Session[];
  return rows[0]??null;
 }
 private async candidates(id:string,s:Session,now:Date) {
  const rows=await this.db.query(STRATEGY_BRAKE_SQL,[
   id,s.broker_connection_id,new Date(now.getTime()-WINDOW_MS).toISOString(),now.toISOString(),
  ]) as Candidate[];
  if(rows.length>100)throw new BadRequestException('Brake notice evidence is too large to verify.');
  const unique=new Map<string,Candidate>();
  for(const x of rows){
   if(!validCandidate(x))continue;
   const key=[x.strategy,x.instrument,x.direction].join(':');
   if(!unique.has(key))unique.set(key,x);
  }
  return [...unique.values()].slice(0,12);
 }
 private async consent(id:string,s:Session,x:Candidate):Promise<Consent|null> {
  const rows=await this.db.query(CONSENT_SQL,[
   id,s.broker_connection_id,x.strategy,x.instrument,x.direction,
  ]) as Consent[];
  return rows[0]??null;
 }
 async getStatus(id:string,now=new Date()):Promise<StrategyBrakeOwnerStatus> {
  const empty:StrategyBrakeOwnerStatus={
   supported:false,active:false,accountType:null,currency:null,incidents:[],
   summary:'Strategy risk decisions are available only to the account owner of the active Pepperstone USD DEMO session.',
   otherModelAndBrokerRiskChecksRemainActive:true,
   overridesHardAccountOrBrokerRisk:false,noAutomaticSideReversal:true,
  };
  const s=await this.session(id);if(!s)return empty;
  const incidents:StrategyBrakeIncident[]=[];
  for(const x of await this.candidates(id,s,now)){
   const d=await this.consent(id,s,x);
   const approved=validContinuedTradingConsent(d,now);
   incidents.push({
    id:[x.strategy,x.instrument,x.direction,iso(x.brake.latestClosedAt!)].join('|'),
    route:x.strategy,instrument:x.instrument,direction:x.direction,
    reason:x.brake.reason,latestBlockedAt:iso(x.evaluated_at),
    incidentClosedAt:iso(x.brake.latestClosedAt!),
    cooldownRemainingSeconds:n(x.brake.cooldownRemainingSeconds),
    persistentNegativePayoff:x.brake.persistentNegativePayoff===true,
    payoffTrades:n(x.brake.payoffClosedTrades),
    profitFactor:x.brake.profitFactor==null?null:n(x.brake.profitFactor),
    recentWins:n(x.brake.recentWins),recentLosses:n(x.brake.recentLosses),
    userDecision:d?.decision==='CONTINUE_TRADING'?'CONTINUE_TRADING':
      d?.decision==='KEEP_PAUSED'?'KEEP_PAUSED':null,
    continueTradingAuthorized:approved,
    requiresOwnerDecision:!d||d.decision==='RESUME_LIMITED',
   });
  }
  return {...empty,supported:true,accountType:'DEMO',currency:'USD',
   active:incidents.length>0,incidents,
   summary:incidents.length?
    'A strategy-loss restriction needs the account owner to choose Pause or Continue Trading.':
    'No recent qualified strategy-loss brake incidents.'};
 }
 async decide(id:string,input:{
  action:Action;route:Route;instrument:string;
  direction:Side;incidentClosedAt:string;
 }):Promise<StrategyBrakeOwnerStatus>{
  if(!['KEEP_PAUSED','CONTINUE_TRADING'].includes(input.action)||
    !ROUTES.includes(input.route)||!PAIRS.includes(input.instrument as typeof PAIRS[number])||
    !['BUY','SELL'].includes(input.direction)||
    !Number.isFinite(Date.parse(input.incidentClosedAt))||
    iso(input.incidentClosedAt)!==input.incidentClosedAt)
   throw new BadRequestException('Invalid strategy brake action or incident.');
  const s=await this.session(id);
  if(!s)throw new ForbiddenException('Only the owner of the active Pepperstone USD DEMO session may choose.');
  const now=new Date();
  const x=(await this.candidates(id,s,now)).find(r=>
   r.strategy===input.route&&r.instrument===input.instrument&&
   r.direction===input.direction&&iso(r.brake.latestClosedAt!)===input.incidentClosedAt);
  if(!x)throw new NotFoundException('This loss-brake incident has changed or is no longer recent.');
  const live=await this.evidence.loadMultimodelLossStreakBrake({
   userId:id,brokerConnectionId:s.broker_connection_id,
   instrument:input.instrument,direction:input.direction,
   strategyRoute:input.route,evaluatedAt:now,
  });
  if(!live.active||
    !['PERSISTENT_NEGATIVE_PAYOFF','RECENT_MULTIMODEL_LOSS_STREAK','RECENT_NEGATIVE_PAYOFF']
      .includes(live.reason)||
    !live.latestClosedAt||live.latestClosedAt.toISOString()!==input.incidentClosedAt)
   throw new BadRequestException('The current broker-backed model brake has changed. Refresh first.');
  const sql=[
   'INSERT INTO trading.demo_strategy_brake_owner_decisions',
   '(user_id,broker_connection_id,trading_session_id,strategy_route,instrument,',
   'direction,brake_reason,incident_closed_at,decision,risk_acknowledged,expires_at)',
   'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
  ].join(' ');
  await this.db.query(sql,[
   id,s.broker_connection_id,s.session_id,input.route,input.instrument,
   input.direction,live.reason,input.incidentClosedAt,input.action,
   false,null,
  ]);
  return this.getStatus(id);
 }
 /** Owner opts into continuing normal DEMO entries for the exact strategy,
  * instrument and direction within this active broker session. The scoped
  * model loss brake is the ONLY check this consent can bypass. */
 async isContinuationApproved(input:{
  userId:string;brokerConnectionId:string;sessionId:string;route:Route;
  instrument:string;direction:Side;reason:string;latestClosedAt:Date;at?:Date;
 }):Promise<boolean>{
  if(!this.owner(input.userId)||
    !['PERSISTENT_NEGATIVE_PAYOFF','RECENT_MULTIMODEL_LOSS_STREAK','RECENT_NEGATIVE_PAYOFF'].includes(input.reason)||
    !ROUTES.includes(input.route)||
    !PAIRS.includes(input.instrument as typeof PAIRS[number]))return false;
  const s=await this.session(input.userId);
  if(!s||s.broker_connection_id!==input.brokerConnectionId||
    s.session_id!==input.sessionId)return false;
  const x:Candidate={strategy:input.route,instrument:input.instrument,
   direction:input.direction,evaluated_at:input.at??new Date(),
   brake:{active:true,reason:input.reason,
    latestClosedAt:input.latestClosedAt.toISOString()}};
  const d=await this.consent(input.userId,s,x);
  return validContinuedTradingConsent(d,input.at??new Date());
 }
}
