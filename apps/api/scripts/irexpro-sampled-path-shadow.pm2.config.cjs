'use strict';
/**
 * Independent research-only sampled quote path replay.
 * Reads forward report + bounded snapshot archives; no broker orders.
 */
module.exports={apps:[{
 name:'irexpro-sampled-path-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/audit-pepperstone-sampled-exit-path.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 // A single bounded replay normally holds roughly 250 MB RSS. A 192 MB
 // process cap caused PM2 to terminate it every 30 seconds and replay the
 // same quote archive repeatedly. Keep headroom, plus a slower error backoff.
 restart_delay:60000,max_memory_restart:'384M',min_uptime:'10s',
 max_restarts:8,
}]};
