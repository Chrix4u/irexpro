'use strict';
// Prospective USD factor research ONLY. No risk change, broker orders or LIVE authority.
module.exports={apps:[{
 name:'irexpro-owner-usd-crosspair-forward-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/watch-owner-demo-usd-crosspair-forward.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:12000,max_memory_restart:'160M',
 min_uptime:'10s',max_restarts:8,
}]};
