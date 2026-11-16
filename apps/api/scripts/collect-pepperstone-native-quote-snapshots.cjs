'use strict';
/**
 * Forward-only as-of sampling of already-persisted native Pepperstone quotes.
 * Research sidecar: SELECT ONLY. No broker request, no order, no API restart.
 * Poll at 2s, append bounded daily JSONL, preserve sample+observation time.
 */
const fs=require('node:fs'),path=require('node:path');
const ROOT='/home/lightworld/webapps/irexpro-research/native-quote-snapshots';
const MAX_DAY_BYTES=36*1024*1024;
const RETAIN_DAYS=7;
const POLL_MS=2000;
const MAX_AGE_MS=10000;
const VALID_PAIRS=new Set(['EURUSD','GBPUSD','AUDUSD','USDJPY','USDCAD','USDCHF']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUERY=[
 'SELECT q.instrument, q.bucket_time, q.last_positive_sample_at AS sample_at,',
 'q.last_positive_bid AS bid, q.last_positive_ask AS ask,',
 'q.last_positive_spread AS spread, q.source',
 'FROM market_data.provider_quote_candles q',
 'JOIN trading.trading_sessions s ON s.broker_connection_id=q.connection_id',
 'JOIN broker.broker_connections b ON b.id=s.broker_connection_id',
 'AND b.user_id=s.user_id',
 "WHERE s.user_id=$1 AND s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'",
 "AND s.account_currency='USD' AND b.broker_id='pepperstone-ctrader'",
 "AND b.account_type='DEMO' AND b.deleted_at IS NULL",
 "AND q.timeframe='M1' AND q.source='ctrader-broker-native'",
 "AND q.positive_quote_sample_count>0 AND q.last_positive_spread>0",
 "AND q.bucket_time>=date_trunc('minute',now())-interval '1 minute'",
 "AND q.last_positive_sample_at>=now()-interval '10 seconds'",
 'ORDER BY q.instrument,q.last_positive_sample_at',
].join(' ');
function numeric(value){
 const n=Number(value);return value===null||value===undefined||!Number.isFinite(n)?null:n;
}
function parseSnapshot(row,observedAt){
 const time=new Date(row.sample_at).getTime(),received=new Date(observedAt).getTime();
 const bucket=new Date(row.bucket_time).getTime();
 const bid=numeric(row.bid),ask=numeric(row.ask),spread=numeric(row.spread);
 if(!VALID_PAIRS.has(row.instrument)||row.source!=='ctrader-broker-native'||
  !Number.isFinite(time)||!Number.isFinite(received)||!Number.isFinite(bucket)||
  time<bucket||time>=bucket+60000||time>received+1000||
  received-time<0||received-time>MAX_AGE_MS||
  !(bid>0&&ask>bid&&spread>0)||
  Math.abs((ask-bid)-spread)>Math.max(0.00000005,spread*0.05))return null;
 // Small positional line avoids writing private broker IDs and extra metadata.
 return [new Date(time).toISOString(),new Date(received).toISOString(),
   row.instrument,bid,ask];
}
function persistSnapshots(rows,observedAt,io=fs,dir=ROOT,seen=new Map()){
 io.mkdirSync(dir,{recursive:true,mode:0o700});
 const byDay=new Map(),accepted=[];
 for(const row of rows){
  const x=parseSnapshot(row,observedAt);
  if(!x)continue;
  const stamp=Date.parse(x[0]),key=x[2];
  if(stamp<=(seen.get(key)??-Infinity))continue;
  seen.set(key,stamp);
  const day=x[0].slice(0,10);
  const group=byDay.get(day)||[];
  group.push(JSON.stringify(x)+'\n');byDay.set(day,group);
  accepted.push(x);
 }
 const written=[],capped=[];
 for(const [day,lines] of byDay){
  const dest=path.join(dir,day+'.jsonl');
  const old=io.existsSync(dest)?io.statSync(dest).size:0;
  const chunk=lines.join('');
  if(old+Buffer.byteLength(chunk)>MAX_DAY_BYTES){
   capped.push(day);continue;
  }
  io.appendFileSync(dest,chunk,{mode:0o600});
  written.push({day,count:lines.length,bytes:Buffer.byteLength(chunk)});
 }
 return {accepted:accepted.length,written,capped};
}
function pruneOldDays(now=new Date(),io=fs,dir=ROOT){
 if(!io.existsSync(dir))return [];
 const threshold=new Date(now.getTime()-RETAIN_DAYS*86400000).toISOString().slice(0,10);
 const removed=[];
 for(const name of io.readdirSync(dir)){
  if(!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))continue;
  const day=name.slice(0,10);
  if(day>=threshold)continue;
  const target=path.join(dir,name);
  if(!io.statSync(target).isFile())continue;
  io.unlinkSync(target);removed.push(day);
 }
 return removed;
}
function countUniqueSamples(rows){
 const groups=new Map();
 for(const row of rows){
  if(!Array.isArray(row)||row.length!==5)continue;
  const key=row[2];
  groups.set(key,(groups.get(key)||0)+1);
 }
 return Object.fromEntries(groups);
}
async function collect(db,owner,seen=new Map(),base=ROOT,now=new Date()){
 if(!UUID.test(owner))throw Error('INVALID_OWNER_SCOPE');
 await db.query('BEGIN READ ONLY');
 try{
  await db.query("SET LOCAL statement_timeout='4000ms'");
  const results=await db.query(QUERY,[owner]);
  await db.query('COMMIT');
  const saved=persistSnapshots(results.rows,now,fs,base,seen);
  return {...saved,rowsReturned:results.rows.length};
 }catch(e){try{await db.query('ROLLBACK')}catch{}throw e;}
}
async function main(){
 require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
 const {Client}=require('pg'),{getDatabaseSslOptions}=require('../dist/config/database-tls');
 const owner=process.env.VPS_FOREX_SCANNER_USER_ID;
 if(!UUID.test(owner||''))throw Error('OWNER_NOT_CONFIGURED');
 const seen=new Map();
 const db=new Client({host:process.env.DB_HOST||'localhost',
  port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME||'irexpro_dev',
  user:process.env.DB_USER||'irexpro',password:process.env.DB_PASSWORD,
  ssl:getDatabaseSslOptions(process.env.DB_SSL==='true'),
  application_name:'irexpro-native-quote-shadow-readonly',
  connectionTimeoutMillis:10000,query_timeout:6000});
 await db.connect();
 let busy=false,requests=0,written=0,lastStatus='',stopped=false;
 async function step(){
  if(busy||stopped)return;
  busy=true;
  try{
   const now=new Date();
   const result=await collect(db,owner,seen,ROOT,now);
   requests++;written+=result.written.reduce((s,x)=>s+x.count,0);
   const status=result.capped.length?'DAILY_BUDGET_REACHED':'CAPTURING_NATIVE_QUOTE_SNAPSHOTS';
   if(status!==lastStatus||requests%300===0){
    console.log('QUOTE_SHADOW_STATUS',JSON.stringify({
     at:now.toISOString(),status,queries:requests,retainedSamples:written,
     dailyCapped:result.capped,
     source:'timestamped-db-observed-ctrader-positive-spread',
     brokerOrders:false,databaseWrites:false,
    }));
    lastStatus=status;
   }
   if(requests%1800===0)pruneOldDays(now);
  }catch(e){console.error('QUOTE_SHADOW_FAILURE',String(e.message).slice(0,160));}
  finally{busy=false;}
 }
 await step();
 if(!process.argv.includes('--watch')){await db.end();return;}
 const interval=setInterval(()=>void step(),POLL_MS);
 const stop=async()=>{
  if(stopped)return;stopped=true;clearInterval(interval);
  while(busy)await new Promise(resolve=>setTimeout(resolve,50));
  await db.end();process.exit(0);
 };
 process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}
module.exports={QUERY,ROOT,MAX_DAY_BYTES,RETAIN_DAYS,POLL_MS,MAX_AGE_MS,
 parseSnapshot,persistSnapshots,pruneOldDays,countUniqueSamples,collect};
if(require.main===module)main().catch(e=>{
 console.error('QUOTE_SHADOW_FATAL',String(e.message).slice(0,160));process.exitCode=1;
});
