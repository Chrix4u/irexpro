'use strict';
/**
 * Independent, research-only +15-second M5 context collector.
 * Reads an existing local append-only native quote archive; emits private
 * sampled-midquote M5 context, NEVER broker-native M5 replacement or orders.
 */
module.exports={apps:[{
  name:'irexpro-m5-asof-context-shadow',
  cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
  script:'scripts/collect-owner-demo-m5-asof-context.cjs',
  args:['--watch'],
  interpreter:'/home/lightworld/runtime/node24/bin/node',
  exec_mode:'fork',
  instances:1,
  watch:false,
  autorestart:true,
  restart_delay:12000,
  max_memory_restart:'128M',
  min_uptime:'10s',
  max_restarts:8,
}]};
