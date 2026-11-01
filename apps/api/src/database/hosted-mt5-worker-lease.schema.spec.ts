import * as fs from 'fs';
import * as path from 'path';

describe('Hosted MT5 worker lease schema', () => {
  const migrationPath = path.resolve(
    __dirname,
    './migrations/1793520000000-AddHostedMt5WorkerLease.ts',
  );

  it('adds IREXPRO_HOSTED and the worker lease fencing columns', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const source = fs.readFileSync(migrationPath, 'utf8');
    expect(source).toContain("'IREXPRO_HOSTED'");
    expect(source).toContain('host_worker_id');
    expect(source).toContain('host_lease_expires_at');
    expect(source).toContain('host_last_seen_at');
    expect(source).toContain('host_last_error');
    expect(source).toContain('idx_direct_mt5_hosted_worker_lease');
  });

  it('restores the previous two-mode constraint when reverted', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const source = fs.readFileSync(migrationPath, 'utf8');
    const down = source.slice(source.indexOf('public async down'));
    expect(down).toContain("CHECK (host_mode IN ('PERSONAL_PC', 'WINDOWS_VPS'))");
    expect(down).toContain('DROP COLUMN IF EXISTS host_worker_id');
  });
});
