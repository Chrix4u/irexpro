import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFrozenCandidateManifest1792641000000 implements MigrationInterface {
  name = 'CreateFrozenCandidateManifest1792641000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.frozen_candidate_manifests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scanner_identity varchar(120) NOT NULL,
        candidate_code varchar(120) NOT NULL,
        policy_version varchar(160) NOT NULL,
        git_commit_sha varchar(40) NOT NULL,
        semantic_policy jsonb NOT NULL,
        manifest_hash varchar(64) NOT NULL,
        deployment_timestamp timestamptz NOT NULL,
        freeze_timestamp timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_frozen_manifest_git_sha CHECK (git_commit_sha ~ '^[0-9A-Fa-f]{40}$'),
        CONSTRAINT chk_frozen_manifest_hash CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT uq_frozen_manifest_identity UNIQUE (
          candidate_code,
          policy_version,
          manifest_hash
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS trading.frozen_candidate_cohorts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        manifest_id uuid NOT NULL UNIQUE
          REFERENCES trading.frozen_candidate_manifests(id) ON DELETE RESTRICT,
        scanner_identity varchar(120) NOT NULL,
        status varchar(40) NOT NULL,
        started_at timestamptz NOT NULL,
        completed_at timestamptz NULL,
        interruption_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_frozen_candidate_cohort_status CHECK (
          status IN ('PENDING','ACTIVE','COMPLETED','FAILED','INTERRUPTED_POLICY_CHANGE')
        )
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_frozen_candidate_active_scanner
      ON trading.frozen_candidate_cohorts (scanner_identity)
      WHERE status = 'ACTIVE'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ix_frozen_candidate_cohort_status_time
      ON trading.frozen_candidate_cohorts (status, started_at DESC)
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trading.reject_frozen_candidate_manifest_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'frozen candidate manifests are immutable';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_reject_frozen_candidate_manifest_mutation
      ON trading.frozen_candidate_manifests
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_reject_frozen_candidate_manifest_mutation
      BEFORE UPDATE OR DELETE ON trading.frozen_candidate_manifests
      FOR EACH ROW EXECUTE FUNCTION trading.reject_frozen_candidate_manifest_mutation()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_reject_frozen_candidate_manifest_mutation
      ON trading.frozen_candidate_manifests
    `);
    await queryRunner.query(`DROP FUNCTION IF EXISTS trading.reject_frozen_candidate_manifest_mutation()`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.frozen_candidate_cohorts`);
    await queryRunner.query(`DROP TABLE IF EXISTS trading.frozen_candidate_manifests`);
  }
}
