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
 restart_delay:10000,max_memory_restart:'192M',min_uptime:'10s',
 max_restarts:8,
}]};
