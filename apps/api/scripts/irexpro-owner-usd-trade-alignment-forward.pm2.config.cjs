'use strict';
// Independent read-only owner USD DEMO trade attribution research. No orders.
module.exports={apps:[{
 name:'irexpro-owner-usd-trade-alignment-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/watch-owner-demo-usd-trade-alignment.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:12000,max_memory_restart:'145M',
 min_uptime:'10s',max_restarts:8,
}]};
