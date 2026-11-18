import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { M1TacticalEvidenceService } from './m1-tactical-evidence.service';

const ROUTES = ['EARLY_TRANSITION','CONFIRMED_REVERSAL'] as const;
const PAIRS = ['EURUSD','AUDUSD','USDJPY','USDCAD'] as const;
const WINDOW_MS = 6 * 3600000;
const APPROVAL_MS = 3600000;
export const DEMO_STRATEGY_RECOVERY_LOT_CAP = 1;
type Route = typeof ROUTES[number];
type Side = 'BUY' | 'SELL';
type Action = 'KEEP_PAUSED' | 'RESUME_LIMITED';
type Session = {session_id:string;broker_connection_id:string};
type Brake = {active:boolean;reason:string;latestClosedAt:string|null;
 cooldownRemainingSeconds?:number;persistentNegativePayoff?:boolean;
 recentWins?:number;recentLosses?:number;profitFactor?:number|null;payoffClosedTrades?:number};
type Candidate = {evaluated_at:string|Date;instrument:string;direction:Side;strategy:Route;brake:Brake};
type Consent = {decision:Action;brake_reason:string;created_at:string|Date;expires_at:string|Date};
export interface StrategyBrakeIncident {
  id:string;route:Route;instrument:string;direction:Side;reason:string;
  latestBlockedAt:string;incidentClosedAt:string;
  cooldownRemainingSeconds:number;persistentNegativePayoff:boolean;
  payoffTrades:number;profitFactor:number|null;recentWins:number;recentLosses:number;
  userDecision:Action|null;resumeLimitedAuthorized:boolean;requiresOwnerDecision:boolean;
  recoveryLotCap:number;maxRecoveryEntries:1;remainingConsentSeconds:number;
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
  "AND d.governance->'demoAlternativeTrial'->>'eligible'='true'",
  "AND d.governance->'multimodelLossStreakBrake'->>'active'='true'",
  "AND d.governance->'multimodelEnsemble'->>'strategyRoute' IN",
  "('EARLY_TRANSITION','CONFIRMED_REVERSAL')",
  'ORDER BY d.evaluated_at DESC,d.id DESC LIMIT 101',
].join(' ');
const CONSENT_SQL=[
 'SELECT decision,brake_reason,created_at,expires_at FROM trading.demo_strategy_brake_owner_decisions',
 'WHERE user_id=$1 AND broker_connection_id=$2 AND trading_session_id=$3',
 'AND strategy_route=$4 AND instrument=$5 AND direction=$6',
 'AND incident_closed_at=$7::timestamptz',
 'ORDER BY created_at DESC,id DESC LIMIT 1',
].join(' ');
const SPENT_SQL=[
 'SELECT COUNT(*)::int n FROM trading.trade_intents ti',
 'WHERE ti.user_id=$1 AND ti.broker_connection_id=$2 AND ti.trading_session_id=$3',
 'AND ti.instrument=$4 AND ti.direction=$5',
 "AND ti.metadata->>'multimodel_plan_b_route'=$6",
 'AND ti.created_at >= $7::timestamptz',
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
export function validLimitedRecoveryConsent(incident:string,d:Consent|null,at:Date,used:number) {
 if(!d||d.decision!=='RESUME_LIMITED'||used!==0)return false;
 const created=new Date(d.created_at).getTime(),expires=new Date(d.expires_at).getTime();
 const incidentAt=Date.parse(incident),current=at.getTime();
 return [created,expires,incidentAt,current].every(Number.isFinite) &&
  created>incidentAt && current>=created && current<expires &&
  expires>created && expires<=created+APPROVAL_MS+1000;
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
   id,s.broker_connection_id,s.session_id,x.strategy,x.instrument,x.direction,
   iso(x.brake.latestClosedAt!),
  ]) as Consent[];
  return rows[0]??null;
 }
 private async spent(id:string,s:Session,x:Candidate,at:Date):Promise<number> {
  const rows=await this.db.query(SPENT_SQL,[
   id,s.broker_connection_id,s.session_id,x.instrument,x.direction,x.strategy,at.toISOString(),
  ]) as Array<{n:number}>;
  return n(rows[0]?.n);
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
   const used=d?.decision==='RESUME_LIMITED'?await this.spent(id,s,x,new Date(x.brake.latestClosedAt!)):0;
   const approved=validLimitedRecoveryConsent(iso(x.brake.latestClosedAt!),d,now,used);
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
    userDecision:d?.decision??null,resumeLimitedAuthorized:approved,
    requiresOwnerDecision:!d,recoveryLotCap:DEMO_STRATEGY_RECOVERY_LOT_CAP,
    maxRecoveryEntries:1,
    remainingConsentSeconds:approved?Math.ceil((new Date(d!.expires_at).getTime()-now.getTime())/1000):0,
   });
  }
  return {...empty,supported:true,accountType:'DEMO',currency:'USD',
   active:incidents.length>0,incidents,
   summary:incidents.length?
    'One or more strategies were blocked by loss protection. The account owner must review each incident.':
    'No recent qualified strategy-loss brake incidents.'};
 }
 async decide(id:string,input:{
  action:Action;acknowledged:boolean;route:Route;instrument:string;
  direction:Side;incidentClosedAt:string;
 }):Promise<StrategyBrakeOwnerStatus>{
  if(!['KEEP_PAUSED','RESUME_LIMITED'].includes(input.action)||
    !ROUTES.includes(input.route)||!PAIRS.includes(input.instrument as typeof PAIRS[number])||
    !['BUY','SELL'].includes(input.direction)||
    !Number.isFinite(Date.parse(input.incidentClosedAt))||
    iso(input.incidentClosedAt)!==input.incidentClosedAt)
   throw new BadRequestException('Invalid strategy brake action or incident.');
  if(input.action==='RESUME_LIMITED'&&!input.acknowledged)
   throw new BadRequestException('Explicit acknowledgement of additional DEMO losses is required.');
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
  // A new approval cannot reset the single-attempt budget. It is anchored
  // to the incident's broker close, not to each appended consent record.
  if(input.action==='RESUME_LIMITED' &&
     await this.spent(id,s,x,new Date(input.incidentClosedAt))>0)
    throw new BadRequestException(
      'The one-entry recovery allowance for this incident has already been used.');
  const sql=[
   'INSERT INTO trading.demo_strategy_brake_owner_decisions',
   '(user_id,broker_connection_id,trading_session_id,strategy_route,instrument,',
   'direction,brake_reason,incident_closed_at,decision,risk_acknowledged,expires_at)',
   'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
  ].join(' ');
  await this.db.query(sql,[
   id,s.broker_connection_id,s.session_id,input.route,input.instrument,
   input.direction,live.reason,input.incidentClosedAt,input.action,
   input.action==='RESUME_LIMITED'&&input.acknowledged,
   new Date(now.getTime()+APPROVAL_MS).toISOString(),
  ]);
  return this.getStatus(id);
 }
 /** Fail closed. One DEMO entry <=1 lot; all other broker/market/portfolio gates still apply. */
 async isRecoveryApproved(input:{
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
  if(!d||d.decision!=='RESUME_LIMITED'||d.brake_reason!==input.reason)return false;
  const used=await this.spent(input.userId,s,x,input.latestClosedAt);
  return validLimitedRecoveryConsent(input.latestClosedAt.toISOString(),
    d,input.at??new Date(),used);
 }
}
