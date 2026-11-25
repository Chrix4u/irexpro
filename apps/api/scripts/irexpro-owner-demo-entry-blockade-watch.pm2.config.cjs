'use strict';
// Research-only Pepperstone DEMO entry blockade monitor.
// It reads decisions and broker settlement, but never writes broker orders.
module.exports={apps:[{
 name:'irexpro-owner-demo-entry-blockade-watch',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/watch-owner-demo-entry-blockers.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:15000,min_uptime:'10s',max_restarts:8,
 max_memory_restart:'110M',
}]};
