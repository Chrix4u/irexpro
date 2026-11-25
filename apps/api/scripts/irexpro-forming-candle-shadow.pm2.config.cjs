'use strict';
/**
 * Research-only forming M1/M5 candle as-of collector.
 * Reads the already-running Pepperstone positive-spread native-quote archive.
 * No broker API calls, no PostgreSQL writes, no order or stop authority.
 *
 * Launch after one-time --backfill:
 * pm2 start scripts/irexpro-forming-candle-shadow.pm2.config.cjs
 */
module.exports={apps:[{
  name:'irexpro-forming-candle-shadow',
  cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
  script:'scripts/collect-owner-demo-forming-candle-snapshots.cjs',
  args:['--watch'],
  interpreter:'/home/lightworld/runtime/node24/bin/node',
  exec_mode:'fork',
  instances:1,
  watch:false,
  autorestart:true,
  restart_delay:10000,
  max_memory_restart:'128M',
  min_uptime:'10s',
  max_restarts:8,
}]};
