// Final real PostgreSQL 16 Gate 3 integration coverage; reconciliation harness registers explicit entities.
import { BadRequestException } from '@nestjs/common';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PerformanceFeeService } from './services/performance-fee.service';
import { BillingFrequency, PerformanceFeePolicy } from './entities/performance-fee-policy.entity';

describe('PerformanceFeeService — real PostgreSQL global-policy singleton', () => {
  let dataSource: DataSource;
  let policyRepo: Repository<PerformanceFeePolicy>;
  let service: PerformanceFeeService;
  const auditLog = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? '5432'),
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'ci_disposable_password',
      database: process.env.DB_NAME ?? 'irexpro_risk_concurrency',
      entities: [PerformanceFeePolicy],
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await dataSource.query('CREATE SCHEMA IF NOT EXISTS performance_fees');
    await dataSource.query('DROP TABLE IF EXISTS performance_fees.performance_fee_policies');
    await dataSource.query(`CREATE TABLE performance_fees.performance_fee_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id UUID NULL,
      name VARCHAR(200) NOT NULL,
      fee_percent NUMERIC(7,4) NOT NULL,
      billing_frequency VARCHAR(32) NOT NULL,
      calculation_mode VARCHAR(32) NOT NULL DEFAULT 'HIGH_WATER_MARK',
      applies_to VARCHAR(32) NOT NULL DEFAULT 'REALISED_PROFIT_ONLY',
      version INTEGER NOT NULL DEFAULT 1,
      effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      effective_to TIMESTAMPTZ NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    policyRepo = dataSource.getRepository(PerformanceFeePolicy);
    service = new PerformanceFeeService(
      policyRepo,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { log: auditLog } as unknown as AuditService,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    auditLog.mockClear();
    await dataSource.query('DELETE FROM performance_fees.performance_fee_policies');
  });

  it('concurrent active-global creation serializes to exactly one persisted policy', async () => {
    const results = await Promise.allSettled([
      service.createPolicy(
        { name: 'Global A', feePercent: 20, billingFrequency: BillingFrequency.MONTHLY },
        'admin-a',
      ),
      service.createPolicy(
        { name: 'Global B', feePercent: 25, billingFrequency: BillingFrequency.MONTHLY },
        'admin-b',
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(BadRequestException);
    }

    const count = await policyRepo.count({ where: { planId: IsNull(), isActive: true } });
    expect(count).toBe(1);
    expect(auditLog).toHaveBeenCalledTimes(1);
  });
});
