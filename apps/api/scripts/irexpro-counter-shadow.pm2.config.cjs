'use strict';
/**
 * Separate, read-only Pepperstone DEMO MAIN-versus-COUNTER research observer.
 * Args '--watch' belong to the script (2-minute polling), NOT PM2 fs watching.
 */
module.exports = {
  apps: [{
    name: 'irexpro-counter-shadow',
    cwd: '/home/lightworld/webapps/irexpro-staging/apps/api',
    script: 'scripts/audit-pepperstone-main-counter-virtual.cjs',
    args: ['--watch'],
    interpreter: '/home/lightworld/runtime/node24/bin/node',
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: true,
    restart_delay: 5000,
    max_memory_restart: '128M',
    min_uptime: '10s',
    max_restarts: 10,
  }],
};
