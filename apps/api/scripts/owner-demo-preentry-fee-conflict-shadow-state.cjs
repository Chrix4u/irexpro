'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const shadow=require('./owner-demo-preentry-fee-conflict-shadow.cjs');
const STATE_ARTIFACT='irexpro-owner-demo-entry-confluence-frozen-prospective-state-v1';
const MARKER_FILE='preentry-fee-double-abstain-activation.json';
const STATE_FILE='preentry-fee-double-abstain-state.json';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const valid=x=>typeof x==='string'&&
 /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const t=x=>x==null?NaN:new Date(x).getTime();
function setup(root,owner,conn,now=new Date()) {
 if(!valid(owner)||!valid(conn)||!Number.isFinite(t(now)))
  throw Error('INVALID_ENTRY_SHADOW_ACCOUNT_SCOPE');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const p=path.join(root,MARKER_FILE);
 if(!fs.existsSync(p)) {
  const marker={
   artifact:shadow.ARTIFACT,activatedAt:new Date(now).toISOString(),
   ownerHash:sha(owner),brokerConnectionHash:sha(conn),
   broker:'pepperstone-ctrader',accountType:'DEMO',accountCurrency:'USD',
   minimumPriorBrokerFeeSamples:12,
   qualifiesOnlyIfFirstObservedOpenAfterActivation:true,
   noPreactivationBackfill:true,noPostCloseWarningBackfill:true,
   cannotVetoEntries:true,cannotChangeLot:true,cannotExit:true,
   cannotChangeProfitProtection:true,cannotPromoteToLive:true,
  };
  try{fs.writeFileSync(p,JSON.stringify(marker,null,2)+'\n',{mode:0o600,flag:'wx'});}
  catch(e){if(e.code!=='EEXIST')throw e;}
 }
 const a=JSON.parse(fs.readFileSync(p,'utf8'));
 if(a.artifact!==shadow.ARTIFACT||a.ownerHash!==sha(owner)||
  a.brokerConnectionHash!==sha(conn)||a.broker!=='pepperstone-ctrader'||
  a.accountType!=='DEMO'||a.accountCurrency!=='USD'||
  a.minimumPriorBrokerFeeSamples!==12||
  a.qualifiesOnlyIfFirstObservedOpenAfterActivation!==true||
  a.noPreactivationBackfill!==true||a.noPostCloseWarningBackfill!==true||
  a.cannotVetoEntries!==true||a.cannotChangeLot!==true||
  a.cannotExit!==true||a.cannotChangeProfitProtection!==true||
  a.cannotPromoteToLive!==true||!Number.isFinite(t(a.activatedAt))||
  t(a.activatedAt)>t(now)) throw Error('INVALID_FROZEN_PREENTRY_CONFLUENCE_MARKER');
 return a;
}
function load(root,marker){
 const p=path.join(root,STATE_FILE);
 if(!fs.existsSync(p))return {
  artifact:STATE_ARTIFACT,activatedAt:marker.activatedAt,
  ownerHash:marker.ownerHash,brokerConnectionHash:marker.brokerConnectionHash,
  observations:{},noBrokerOrders:true,noRetrospectiveEntryScoring:true,
 };
 const s=JSON.parse(fs.readFileSync(p,'utf8'));
 if(s.artifact!==STATE_ARTIFACT||
  s.activatedAt!==marker.activatedAt||s.ownerHash!==marker.ownerHash||
  s.brokerConnectionHash!==marker.brokerConnectionHash||
  s.noBrokerOrders!==true||s.noRetrospectiveEntryScoring!==true||
  typeof s.observations!=='object'||s.observations===null||
  Array.isArray(s.observations)||Object.keys(s.observations).length>500)
  throw Error('INVALID_FROZEN_PREENTRY_CONFLUENCE_STATE');
 return s;
}
function freeze(rows,state,marker,now=new Date()){
 const asOf=t(now),start=t(marker.activatedAt);
 if(!Number.isFinite(asOf)||!Number.isFinite(start)||asOf<start)
  throw Error('INVALID_PREENTRY_RESEARCH_CLOCK');
 const copy={...state,observations:{...state.observations}};
 let newCaptures=0;
 for(const r of rows){
  const opened=t(r.opened_at);
  if(!r.trade_id||!Number.isFinite(opened)||opened>asOf)
   throw Error('INVALID_TRADE_FOR_PREENTRY_RESEARCH');
  if(opened<start||Object.hasOwn(copy.observations,r.trade_id))continue;
  if(Object.keys(copy.observations).length>=500)
   throw Error('FROZEN_PREENTRY_RESEARCH_POSITION_BOUND');
  if(r.status!=='OPEN'){
   copy.observations[r.trade_id]={
    artifact:shadow.ARTIFACT,label:'MISSED_WHILE_OPEN_NOT_CAPTURED',
    eligible:false,shadowWouldDiscourageEntry:false,
    observedClosedAt:new Date(asOf).toISOString(),
    noAfterCloseBackfill:true,noEntryVeto:true,noBrokerOrders:true,
   };
  }else{
   const result=shadow.classify(r,now,marker.activatedAt);
   copy.observations[r.trade_id]=result;
  }
  newCaptures++;
 }
 return {state:copy,newCaptures};
}
function save(root,state){
 const dest=path.join(root,STATE_FILE),
  tmp=dest+'.tmp-'+process.pid;
 try{
  fs.writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(tmp,dest);
 }finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
module.exports={STATE_ARTIFACT,MARKER_FILE,STATE_FILE,setup,load,freeze,save};
