'use strict';
// Owner Pepperstone cTrader USD DEMO ONLY. Read-only 5/10/15/20m recovery
// research; cannot amend a stop, exit a position, or modify AI protection.
module.exports={apps:[{
 name:'irexpro-owner-recovery-risk-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/watch-owner-demo-recovery-risk-shadow.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:12000,max_memory_restart:'160M',
 min_uptime:'10s',max_restarts:8,
}]};
