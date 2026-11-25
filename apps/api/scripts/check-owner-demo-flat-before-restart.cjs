#!/usr/bin/env node
'use strict';
/**
 * OWNER Pepperstone USD DEMO flat-position preflight. No trading authority.
 * Intentionally exits 45 when any position is open, 46 for scope/DB errors.
 */
require('/home/lightworld/webapps/irexpro-staging/apps/api/node_modules/dotenv').config({
 path:'/home/lightworld/webapps/irexpro-staging/apps/api/.env',quiet:true});
const {Client}=require('/home/lightworld/webapps/irexpro-staging/apps/api/node_modules/pg');
const valid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
const broker=process.env.IREXPRO_OWNER_PEPPERSTONE_DEMO_NOON_TRIAL_BROKER_CONNECTION_ID;
if(!valid.test(owner||'')||!valid.test(broker||'')){
 console.error('INVALID_EXACT_OWNER_DEMO_SCOPE');process.exit(46);
}
const SQL=[
 'SELECT t.instrument,t.direction,t.opened_at,t.lot_size',
 'FROM trading.trades t',
 'JOIN broker.broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id',
 'WHERE t.user_id=$1 AND t.broker_connection_id=$2',
 "AND b.broker_id='pepperstone-ctrader' AND b.account_type='DEMO'",
 "AND b.account_currency='USD' AND b.deleted_at IS NULL",
 "AND t.account_currency='USD' AND t.status='OPEN'",
 'ORDER BY t.opened_at LIMIT 50',
].join(' ');
async function run(){
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:false}:undefined,
  connectionTimeoutMillis:6000,statement_timeout:10000,
  application_name:'irexpro-owner-flat-only-release-preflight-READONLY'});
 await db.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const a=(await db.query(SQL,[owner,broker])).rows;
  await db.query('ROLLBACK');
  if(a.length){
   console.error('DEPLOY_BLOCKED_OPEN_OWNER_DEMO_POSITIONS',a.length,
    a.map(x=>[x.instrument,x.direction,x.opened_at,x.lot_size]));
   process.exitCode=45;
   return false;
  }
  console.log('EXACT_OWNER_PEPPERSTONE_USD_DEMO_FLAT',new Date().toISOString());
  return true;
 }catch(e){
  await db.query('ROLLBACK').catch(()=>{});
  throw e;
 }finally{await db.end()}
}
if(require.main===module)run().catch(e=>{
 console.error('EXACT_OWNER_FLAT_PREFLIGHT_FAILED',String(e.message).slice(0,180));
 process.exitCode=46;
});
module.exports={SQL,run};
