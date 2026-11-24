import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Native broker identifier separation on trading.orders (Sprint correction).
 *
 * The order row previously carried ONE provider identifier
 * (provider_order_id), which cTrader MARKET fills populated with the
 * POSITION id (BrokerOrderResult.externalOrderId) while the native ORDER id
 * (brokerNativeOrderId) was dropped and no DEAL id was persisted anywhere —
 * exactly the conflation the broker interface warns against. Reconciliation
 * by stable identifier (step 7b, getOrderById) therefore could not resolve
 * id-less close orders, and proof-based recovery had no durable place to
 * record which native order/deal produced a booked fill.
 *
 * ADDITIVE, NULL-safe columns only — no data rewrite, no constraint that
 * could invalidate existing rows. provider_position_id records the position
 * a MARKET order opened/closed; provider_deal_id records the native closing
 * deal that proved a reconciliation fill. provider_order_id keeps the
 * NATIVE ORDER id going forward (mapper prefers brokerNativeOrderId); the
 * three are never interchangeable.
 *
 * The partial unique index additionally enforces duplicate-deal attribution
 * prevention: one native broker deal may be recorded on at most ONE order
 * row per broker connection, so repeated or concurrent reconciliation can
 * never credit the same provider deal to multiple internal orders. NULL and
 * empty-string deal ids (the whole pre-existing population) are outside the
 * index, so existing rows are untouched.
 */
export class AddOrderProviderNativeIdentifiers1795220000000 implements MigrationInterface {
  name = 'AddOrderProviderNativeIdentifiers1795220000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE trading.orders
        ADD COLUMN IF NOT EXISTS provider_position_id varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS provider_deal_id varchar(255) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE trading.orders
        DROP CONSTRAINT IF EXISTS ck_orders_native_identifier_shape
    `);
    await queryRunner.query(`
      ALTER TABLE trading.orders
        ADD CONSTRAINT ck_orders_native_identifier_shape CHECK (
          (provider_position_id IS NULL OR provider_position_id <> '')
          AND (provider_deal_id IS NULL OR provider_deal_id <> '')
        )
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN trading.orders.provider_position_id IS
        'Broker-native POSITION id for MARKET order fills (cTrader positionId). Never substitute for provider_order_id (native ORDER id) or provider_deal_id.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN trading.orders.provider_deal_id IS
        'Broker-native DEAL id that proved a reconciliation-booked fill (cTrader dealId). Populated only from provider evidence; never fabricated.'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_provider_deal_id
        ON trading.orders (broker_connection_id, provider_deal_id)
        WHERE provider_deal_id IS NOT NULL AND provider_deal_id <> ''
    `);
    await queryRunner.query(`
      COMMENT ON INDEX trading.uq_orders_provider_deal_id IS
        'One native broker deal may be attributed to at most one internal order row per broker connection — duplicate-deal attribution guard.'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS trading.uq_orders_provider_deal_id
    `);
    await queryRunner.query(`
      ALTER TABLE trading.orders
        DROP CONSTRAINT IF EXISTS ck_orders_native_identifier_shape
    `);
    await queryRunner.query(`
      ALTER TABLE trading.orders
        DROP COLUMN IF EXISTS provider_position_id,
        DROP COLUMN IF EXISTS provider_deal_id
    `);
  }
}
