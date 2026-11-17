'use strict';
module.exports={apps:[{
 name:'irexpro-forming-candle-forward-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/owner-demo-forming-candle-forward-shadow.cjs',
 args:['--watch'],interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:12000,max_memory_restart:'160M',min_uptime:'10s',max_restarts:8,
}]};
