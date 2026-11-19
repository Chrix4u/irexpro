import { MigrationInterface, QueryRunner } from 'typeorm';

/** Owner can permanently choose Keep Paused or Continue Trading for a DEMO route. */
export class EnableDemoStrategyOwnerContinue1795030000000 implements MigrationInterface {
 name='EnableDemoStrategyOwnerContinue1795030000000';
 async up(q:QueryRunner):Promise<void>{
  await q.query(`
   ALTER TABLE trading.demo_strategy_brake_owner_decisions
   DROP CONSTRAINT chk_demo_strategy_owner_decision,
   DROP CONSTRAINT chk_demo_strategy_owner_risk_ack,
   DROP CONSTRAINT chk_demo_strategy_owner_expiry,
   DROP CONSTRAINT chk_demo_strategy_owner_route
  `);
  await q.query(`
   ALTER TABLE trading.demo_strategy_brake_owner_decisions
   ALTER COLUMN expires_at DROP NOT NULL
  `);
  await q.query(`
   ALTER TABLE trading.demo_strategy_brake_owner_decisions
   ADD CONSTRAINT chk_demo_strategy_owner_route
    CHECK (strategy_route IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL','TREND_CONTINUATION')),
   ADD CONSTRAINT chk_demo_strategy_owner_decision
    CHECK (decision IN ('KEEP_PAUSED','CONTINUE_TRADING','RESUME_LIMITED')),
   ADD CONSTRAINT chk_demo_strategy_owner_expiry
    CHECK (
     (decision IN ('KEEP_PAUSED','CONTINUE_TRADING') AND
       (expires_at IS NULL OR expires_at > created_at))
     OR
     (decision='RESUME_LIMITED' AND risk_acknowledged=true AND
       expires_at > created_at AND expires_at <= created_at+interval '1 hour')
    )
  `);
  await q.query(`
   CREATE INDEX IF NOT EXISTS idx_demo_strategy_owner_account_choice
   ON trading.demo_strategy_brake_owner_decisions
   (user_id,broker_connection_id,strategy_route,instrument,direction,created_at DESC,id DESC)
  `);
 }
 async down(q:QueryRunner):Promise<void>{
  await q.query(`DROP INDEX IF EXISTS trading.idx_demo_strategy_owner_account_choice`);
  await q.query(`
   DELETE FROM trading.demo_strategy_brake_owner_decisions
   WHERE decision='CONTINUE_TRADING' OR strategy_route='TREND_CONTINUATION'
  `);
  await q.query(`
   UPDATE trading.demo_strategy_brake_owner_decisions
   SET expires_at=created_at+interval '1 hour'
   WHERE expires_at IS NULL
  `);
  await q.query(`
   ALTER TABLE trading.demo_strategy_brake_owner_decisions
   DROP CONSTRAINT chk_demo_strategy_owner_decision,
   DROP CONSTRAINT chk_demo_strategy_owner_expiry,
   DROP CONSTRAINT chk_demo_strategy_owner_route
  `);
  await q.query(`
   ALTER TABLE trading.demo_strategy_brake_owner_decisions
   ALTER COLUMN expires_at SET NOT NULL
  `);
  await q.query(`
   ALTER TABLE trading.demo_strategy_brake_owner_decisions
   ADD CONSTRAINT chk_demo_strategy_owner_route
    CHECK (strategy_route IN ('EARLY_TRANSITION','CONFIRMED_REVERSAL')),
   ADD CONSTRAINT chk_demo_strategy_owner_decision
    CHECK (decision IN ('KEEP_PAUSED','RESUME_LIMITED')),
   ADD CONSTRAINT chk_demo_strategy_owner_risk_ack
    CHECK (decision <> 'RESUME_LIMITED' OR risk_acknowledged=true),
   ADD CONSTRAINT chk_demo_strategy_owner_expiry
    CHECK (expires_at > created_at AND expires_at <= created_at+interval '1 hour')
  `);
 }
}
