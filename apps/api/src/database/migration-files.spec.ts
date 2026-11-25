import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { discoverMigrationFiles } from './migration-files';

describe('migration module discovery', () => {
  it('selects timestamped source migrations only, excluding test and build artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'irexpro-migrations-'));
    try {
      for (const file of [
        '1795628400000-HardenLedger.ts',
        '1795220000000-AddIdentifiers.ts',
        '1795628400000-HardenLedger.spec.ts',
        '1795628400000-HardenLedger.test.ts',
        '1795628400000-HardenLedger.d.ts',
        '1795628400000-HardenLedger.js',
        'helper.ts',
      ]) {
        writeFileSync(join(directory, file), '');
      }
      mkdirSync(join(directory, '1795564800000-NotAFile.ts'));
      expect(discoverMigrationFiles(directory).map((file) => basename(file))).toEqual([
        '1795220000000-AddIdentifiers.ts',
        '1795628400000-HardenLedger.ts',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('discovers the accounting migrations without importing colocated Jest specs', () => {
    const files = discoverMigrationFiles(join(__dirname, 'migrations'));
    expect(files.map((file) => basename(file))).toEqual(
      expect.arrayContaining([
        '1795220000000-AddOrderProviderNativeIdentifiers.ts',
        '1795564800000-CreateOrderFillEvidenceLedger.ts',
        '1795628400000-HardenOrderFillEvidenceLedger.ts',
      ]),
    );
    expect(files.every((file) => !/\.(spec|test|d)\.ts$/.test(file))).toBe(true);
  });
});
