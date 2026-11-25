import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Only timestamped migration modules, never test fixtures or declaration files. */
export function discoverMigrationFiles(directory: string): string[] {
  const extension = extname(__filename);
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^\d{13}-[A-Za-z0-9_-]+\.(ts|js)$/.test(entry.name) &&
        extname(entry.name) === extension,
    )
    .map((entry) => join(directory, entry.name))
    .sort();
}
