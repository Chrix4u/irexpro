'use strict';
// Exact owner Pepperstone USD DEMO, read-only 0.25R shadow. No broker orders.
module.exports={apps:[{
 name:'irexpro-owner-low-peak-forward-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/watch-owner-demo-low-peak-profit-shadow.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:12000,max_memory_restart:'140M',
 min_uptime:'10s',max_restarts:8,
}]};
