'use strict';
// Owner Pepperstone USD DEMO, read-only prospective audit.
// No execution imports, no extra paid quote data, no live authority.
module.exports={apps:[{
 name:'irexpro-prospective-entry-timing-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/collect-owner-demo-prospective-entry-timing.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:12000,max_memory_restart:'140M',
 min_uptime:'10s',max_restarts:8,
}]};
