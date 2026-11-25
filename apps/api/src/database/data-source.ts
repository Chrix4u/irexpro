import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { discoverMigrationFiles } from './migration-files';

dotenv.config({ path: join(__dirname, '../../.env') });

/**
 * TypeORM DataSource for CLI migration commands.
 * Used by: pnpm migration:generate / migration:run / migration:revert
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME ?? 'irexpro_dev',
  username: process.env.DB_USER ?? 'irexpro',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
  entities: [join(__dirname, '../modules/**/*.entity{.ts,.js}')],
  migrations: discoverMigrationFiles(join(__dirname, 'migrations')),
  subscribers: [join(__dirname, './subscribers/*{.ts,.js}')],
});
