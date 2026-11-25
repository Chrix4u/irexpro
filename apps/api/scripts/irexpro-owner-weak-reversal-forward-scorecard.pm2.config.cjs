'use strict';
// Independent owner USD DEMO broker-settlement audit. It never calls orders,
// changes models, pauses AI sessions or amends an existing stop or target.
module.exports={apps:[{
 name:'irexpro-owner-weak-reversal-forward-scorecard',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/watch-owner-demo-weak-reversal-ceiling-forward.cjs',
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:15000,max_memory_restart:'125M',
 min_uptime:'10s',max_restarts:6,
}]};
