'use strict';
/**
 * Read-only owner-scoped DEMO guard-exit market-path research.
 * Every 30 minutes refreshes bounded seven-day as-of bid/ask comparison;
 * does NOT change an exit, enter an order, connect to the broker for execution,
 * train a model, or modify a trading session.
 */
module.exports={apps:[{
  name:'irexpro-owner-demo-drawdown-guard-postexit-shadow',
  cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
  script:'scripts/audit-owner-demo-drawdown-guard-postexit.cjs',
  args:['--watch'],
  interpreter:'/home/lightworld/runtime/node24/bin/node',
  exec_mode:'fork',instances:1,watch:false,autorestart:true,
  restart_delay:30000,max_memory_restart:'500M',min_uptime:'10s',max_restarts:8,
}]};
