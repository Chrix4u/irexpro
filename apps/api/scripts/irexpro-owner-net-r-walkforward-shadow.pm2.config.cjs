'use strict';
// Owner Pepperstone USD DEMO, 30-minute read-only score calibration watcher.
// No trade authority, broker order access, paid quote provider or LIVE entry.
module.exports={apps:[{
 name:'irexpro-owner-net-r-walkforward-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/watch-owner-demo-net-r-walkforward.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,
 autorestart:true,restart_delay:15000,min_uptime:'10s',
 max_restarts:8,max_memory_restart:'120M',
}]};
