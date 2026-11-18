'use strict';
// Owner Pepperstone USD DEMO. Read-only, never sends or modifies an order.
// All pre-entry hypotheses are frozen before any future broker entry occurs.
module.exports={apps:[{
 name:'irexpro-owner-loss-pattern-forward-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/watch-owner-demo-loss-pattern-shadow.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:12000,max_memory_restart:'140M',
 min_uptime:'10s',max_restarts:8,
}]};
