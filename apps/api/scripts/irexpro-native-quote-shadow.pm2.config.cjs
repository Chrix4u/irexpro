'use strict';
/**
 * Bounded, future-only quote retention. Uses existing persisted M1 data,
 * no extra provider API charges and no new app migrations.
 */
module.exports = {apps:[{
 name:'irexpro-native-quote-shadow',
 cwd:'/home/lightworld/webapps/irexpro-staging/apps/api',
 script:'scripts/collect-pepperstone-native-quote-snapshots.cjs',
 args:['--watch'],
 interpreter:'/home/lightworld/runtime/node24/bin/node',
 exec_mode:'fork',instances:1,watch:false,autorestart:true,
 restart_delay:10000,max_memory_restart:'128M',min_uptime:'10s',
 max_restarts:8,
}]};
