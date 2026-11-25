'use strict';
/**
 * Owner-scoped read-only M5 quote-context research-label/readiness audit.
 * No broker calls or trades. Wakes every 14 minutes to produce an audit
 * from prospective immutable v2 +15s quotes and later native M5 labels.
 */
module.exports={apps:[{
  name:'irexpro-m5-quote-readiness-shadow',
  cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
  script:'scripts/run-owner-demo-m5-quote-context-readiness.cjs',
  args:['--watch'],
  interpreter:'/home/lightworld/runtime/node24/bin/node',
  exec_mode:'fork',instances:1,watch:false,autorestart:true,
  restart_delay:20000,max_memory_restart:'160M',
  min_uptime:'10s',max_restarts:8,
}]};
