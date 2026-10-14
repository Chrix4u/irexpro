import { getMetadataArgsStorage } from 'typeorm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TradeIntent } from './trade-intent.entity';

describe('TradeIntent model-version schema contract', () => {
  it('allows durable model provenance longer than 100 characters', () => {
    const column = getMetadataArgsStorage().columns.find(
      (item) => item.target === TradeIntent && item.propertyName === 'modelVersion',
    );

    expect(column).toBeDefined();
    expect(Number(column?.options.length)).toBeGreaterThanOrEqual(255);
  });

  it('includes a migration that widens execution.trade_intents.model_version', () => {
    const migrationsDir = path.resolve(__dirname, '../../../database/migrations');
    const migrationBodies = fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
      .join('\n');

    expect(migrationBodies).toMatch(
      /ALTER\s+TABLE\s+execution\.trade_intents[\s\S]*ALTER\s+COLUMN\s+model_version[\s\S]*TYPE\s+varchar\(255\)/i,
    );
  });
});
