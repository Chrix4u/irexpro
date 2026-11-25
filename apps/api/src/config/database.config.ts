import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { join } from 'path';
import { discoverMigrationFiles } from '../database/migration-files';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => ({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'irexpro_dev',
    username: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    synchronize: false,
    logging: process.env.DB_LOGGING === 'true',
    autoLoadEntities: true,
    migrations: discoverMigrationFiles(join(__dirname, '../database/migrations')),
    migrationsRun: false,
    extra: {
      max: parseInt(process.env.DB_MAX_CONNECTIONS ?? '10', 10),
    },
  }),
);
