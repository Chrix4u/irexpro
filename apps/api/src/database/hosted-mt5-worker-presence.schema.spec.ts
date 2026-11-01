import * as fs from 'fs';
import * as path from 'path';

describe('Hosted MT5 worker presence schema', () => {
  const migrationPath = path.resolve(
    __dirname,
    './migrations/1793530000000-AddHostedMt5WorkerPresence.ts',
  );

  it('creates a durable worker presence table with capacity and freshness fields', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const source = fs.readFileSync(migrationPath, 'utf8');
    expect(source).toContain('broker.hosted_mt5_workers');
    expect(source).toContain('worker_id');
    expect(source).toContain('worker_version');
    expect(source).toContain('runtime_ready');
    expect(source).toContain('max_sessions');
    expect(source).toContain('active_sessions');
    expect(source).toContain('last_seen_at');
    expect(source).toContain('ck_hosted_mt5_workers_capacity');
    expect(source).toContain('idx_hosted_mt5_workers_last_seen');
  });

  it('drops the worker presence table on rollback', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const source = fs.readFileSync(migrationPath, 'utf8');
    const down = source.slice(source.indexOf('public async down'));
    expect(down).toContain('DROP TABLE IF EXISTS broker.hosted_mt5_workers');
  });
});
