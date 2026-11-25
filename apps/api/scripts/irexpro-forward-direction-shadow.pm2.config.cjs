'use strict';
/**
 * Read-only owner-scoped Pepperstone DEMO future forecast calibration.
 * A separate observer. No API/AI service restart or broker order dispatch.
 */
module.exports = {
  apps: [{
    name: 'irexpro-forward-direction-shadow',
    cwd: '/home/lightworld/webapps/irexpro-staging/apps/api',
    script: 'scripts/audit-pepperstone-forward-direction-calibration.cjs',
    args: ['--watch'],
    interpreter: '/home/lightworld/runtime/node24/bin/node',
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: true,
    restart_delay: 10000,
    max_memory_restart: '128M',
    min_uptime: '10s',
    max_restarts: 8,
  }],
};
