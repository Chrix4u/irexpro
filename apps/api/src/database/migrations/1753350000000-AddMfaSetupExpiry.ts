import { MigrationInterface, QueryRunner } from 'typeorm';

/** Bound pending TOTP enrollment so abandoned setup material cannot remain valid indefinitely. */
export class AddMfaSetupExpiry1753350000000 implements MigrationInterface {
  name = 'AddMfaSetupExpiry1753350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity"."users"
      ADD COLUMN IF NOT EXISTS "mfa_setup_expires_at" timestamptz NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'chk_users_mfa_setup_expiry_requires_secret'
            AND conrelid = '"identity"."users"'::regclass
        ) THEN
          ALTER TABLE "identity"."users"
          ADD CONSTRAINT "chk_users_mfa_setup_expiry_requires_secret"
          CHECK ("mfa_setup_expires_at" IS NULL OR "mfa_secret" IS NOT NULL);
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity"."users"
      DROP CONSTRAINT IF EXISTS "chk_users_mfa_setup_expiry_requires_secret"
    `);
    await queryRunner.query(`
      ALTER TABLE "identity"."users"
      DROP COLUMN IF EXISTS "mfa_setup_expires_at"
    `);
  }
}
