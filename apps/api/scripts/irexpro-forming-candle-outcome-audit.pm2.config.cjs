'use strict';
/**
 * Read-only five-minute retrospective evaluation of previously logged
 * research forecasts, once the actual M1/M5 next candle has closed.
 */
module.exports={apps:[{
 name:'irexpro-forming-candle-outcome-audit',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/audit-owner-demo-prospective-candle-outcomes.cjs',
 args:['--watch'],interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:15000,max_memory_restart:'150M',min_uptime:'10s',max_restarts:8,
}]};
