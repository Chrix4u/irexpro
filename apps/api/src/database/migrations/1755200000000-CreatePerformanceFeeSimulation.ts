import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePerformanceFeeSimulation1755200000000 implements MigrationInterface {
  name = 'CreatePerformanceFeeSimulation1755200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS performance_fees`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS performance_fees.performance_fee_simulation_states (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL REFERENCES broker.broker_connections(id) ON DELETE CASCADE,
        currency varchar(3) NOT NULL,
        current_high_water_mark bigint NOT NULL DEFAULT 0,
        total_fees_simulated bigint NOT NULL DEFAULT 0,
        last_settled_realised_balance bigint NOT NULL DEFAULT 0,
        last_simulated_settlement_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_perf_fee_sim_state_account UNIQUE(user_id, broker_connection_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_perf_fee_sim_state_user
      ON performance_fees.performance_fee_simulation_states(user_id)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS performance_fees.performance_fee_simulation_charges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        broker_connection_id uuid NOT NULL REFERENCES broker.broker_connections(id) ON DELETE CASCADE,
        source_mode varchar(10) NOT NULL,
        currency varchar(3) NOT NULL,
        period_start timestamptz NULL,
        period_end timestamptz NULL,
        trade_count integer NOT NULL DEFAULT 0,
        starting_high_water_mark bigint NOT NULL,
        ending_realised_balance bigint NOT NULL,
        realised_profit_for_fee bigint NOT NULL,
        fee_percent numeric(7,4) NOT NULL,
        fee_amount bigint NOT NULL,
        status varchar(20) NOT NULL,
        simulated_settled_at timestamptz NULL,
        metadata jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_perf_fee_sim_charge_user_account
      ON performance_fees.performance_fee_simulation_charges(
        user_id, broker_connection_id, created_at DESC
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_perf_fee_sim_open_charge
      ON performance_fees.performance_fee_simulation_charges(user_id, broker_connection_id)
      WHERE status = 'DUE_TEST'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS performance_fees.performance_fee_simulation_charges
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS performance_fees.performance_fee_simulation_states
    `);
  }
}
