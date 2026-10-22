import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  UNIFIED_FROZEN_CANDIDATE_CODE,
  UNIFIED_FROZEN_POLICY_VERSION,
  type FrozenCandidateSemanticPolicy,
} from './unified-frozen-candidate';

export type FrozenCandidateCohortStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED_POLICY_CHANGE';

export interface FrozenCandidateManifest {
  id: string;
  cohortId: string | null;
  scannerIdentity: string;
  candidateCode: string;
  policyVersion: string;
  gitCommitSha: string;
  semanticPolicy: FrozenCandidateSemanticPolicy;
  manifestHash: string;
  deploymentTimestamp: Date;
  freezeTimestamp: Date;
  status: FrozenCandidateCohortStatus;
  interruptionReason: string | null;
}

export interface EnsureActiveFrozenCandidateManifestInput {
  scannerIdentity: string;
  gitCommitSha: string;
  semanticPolicy: FrozenCandidateSemanticPolicy;
  deploymentTimestamp: Date;
}

type ManifestRow = {
  id: string;
  cohort_id?: string | null;
  scanner_identity: string;
  candidate_code: string;
  policy_version: string;
  git_commit_sha: string;
  semantic_policy: FrozenCandidateSemanticPolicy | string;
  manifest_hash: string;
  deployment_timestamp: string | Date;
  freeze_timestamp: string | Date;
  status: FrozenCandidateCohortStatus;
  interruption_reason: string | null;
};

export class FrozenCandidatePolicyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrozenCandidatePolicyMismatchError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

export function hashFrozenCandidateSemanticPolicy(policy: FrozenCandidateSemanticPolicy): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(policy)), 'utf8').digest('hex');
}

@Injectable()
export class FrozenCandidateManifestService {
  constructor(private readonly dataSource: DataSource) {}

  async ensureActiveManifest(
    input: EnsureActiveFrozenCandidateManifestInput,
  ): Promise<FrozenCandidateManifest> {
    this.assertInput(input);
    const expectedHash = hashFrozenCandidateSemanticPolicy(input.semanticPolicy);
    const active = await this.loadActiveManifest(input.scannerIdentity);
    if (active) {
      this.assertMatches(active, input, expectedHash);
      return active;
    }

    const inserted = (await this.dataSource.query(
      `
        INSERT INTO trading.frozen_candidate_manifests (
          scanner_identity,
          candidate_code,
          policy_version,
          git_commit_sha,
          semantic_policy,
          manifest_hash,
          deployment_timestamp,
          freeze_timestamp
        ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7)
        ON CONFLICT (candidate_code, policy_version, manifest_hash) DO NOTHING
        RETURNING id
      `,
      [
        input.scannerIdentity,
        input.semanticPolicy.candidateCode,
        input.semanticPolicy.policyVersion,
        input.gitCommitSha,
        JSON.stringify(canonicalize(input.semanticPolicy)),
        expectedHash,
        input.deploymentTimestamp.toISOString(),
      ],
    )) as Array<{ id: string }>;

    let manifestId = inserted[0]?.id ?? null;
    if (!manifestId) {
      const exact = (await this.dataSource.query(
        `
          SELECT id
          FROM trading.frozen_candidate_manifests
          WHERE candidate_code = $1
            AND policy_version = $2
            AND manifest_hash = $3
            AND git_commit_sha = $4
          LIMIT 1
        `,
        [
          input.semanticPolicy.candidateCode,
          input.semanticPolicy.policyVersion,
          expectedHash,
          input.gitCommitSha,
        ],
      )) as Array<{ id: string }>;
      manifestId = exact[0]?.id ?? null;
    }

    if (!manifestId) {
      throw new FrozenCandidatePolicyMismatchError(
        'Frozen candidate manifest could not be created or resolved exactly; execution is blocked.',
      );
    }

    try {
      await this.dataSource.query(
        `
          INSERT INTO trading.frozen_candidate_cohorts (
            manifest_id,
            scanner_identity,
            status,
            started_at
          ) VALUES ($1,$2,'ACTIVE',$3)
          ON CONFLICT (manifest_id) DO NOTHING
        `,
        [manifestId, input.scannerIdentity, input.deploymentTimestamp.toISOString()],
      );
    } catch {
      const concurrent = await this.loadActiveManifest(input.scannerIdentity);
      if (!concurrent) {
        throw new FrozenCandidatePolicyMismatchError(
          'Frozen candidate cohort activation failed and no active manifest can be verified.',
        );
      }
      this.assertMatches(concurrent, input, expectedHash);
      return concurrent;
    }

    const created = await this.loadActiveManifest(input.scannerIdentity);
    if (!created) {
      throw new FrozenCandidatePolicyMismatchError(
        'Frozen candidate manifest was persisted but active cohort verification failed.',
      );
    }
    this.assertMatches(created, input, expectedHash);
    return created;
  }

  async assertExecutionPolicy(
    manifestId: string,
    policyVersion: string,
  ): Promise<FrozenCandidateManifest> {
    if (!manifestId || !policyVersion) {
      throw new FrozenCandidatePolicyMismatchError(
        'Frozen candidate manifest id and policy version are required for PAPER execution.',
      );
    }
    const rows = (await this.dataSource.query(
      `
        SELECT
          m.id,
          c.id AS cohort_id,
          c.scanner_identity,
          m.candidate_code,
          m.policy_version,
          m.git_commit_sha,
          m.semantic_policy,
          m.manifest_hash,
          m.deployment_timestamp,
          m.freeze_timestamp,
          c.status,
          c.interruption_reason
        FROM trading.frozen_candidate_manifests m
        JOIN trading.frozen_candidate_cohorts c ON c.manifest_id = m.id
        WHERE m.id = $1
          AND m.candidate_code = $2
          AND m.policy_version = $3
          AND c.status = 'ACTIVE'
        LIMIT 1
      `,
      [manifestId, UNIFIED_FROZEN_CANDIDATE_CODE, policyVersion],
    )) as ManifestRow[];
    const manifest = rows[0] ? this.toManifest(rows[0]) : null;
    if (!manifest || manifest.policyVersion !== UNIFIED_FROZEN_POLICY_VERSION) {
      throw new FrozenCandidatePolicyMismatchError(
        'Active frozen candidate policy does not exactly match execution authority; PAPER execution is blocked.',
      );
    }
    const recomputed = hashFrozenCandidateSemanticPolicy(manifest.semanticPolicy);
    if (recomputed !== manifest.manifestHash) {
      throw new FrozenCandidatePolicyMismatchError(
        'Frozen candidate manifest hash verification failed; PAPER execution is blocked.',
      );
    }
    return manifest;
  }

  private async loadActiveManifest(scannerIdentity: string): Promise<FrozenCandidateManifest | null> {
    const rows = (await this.dataSource.query(
      `
        SELECT
          m.id,
          c.id AS cohort_id,
          c.scanner_identity,
          m.candidate_code,
          m.policy_version,
          m.git_commit_sha,
          m.semantic_policy,
          m.manifest_hash,
          m.deployment_timestamp,
          m.freeze_timestamp,
          c.status,
          c.interruption_reason
        FROM trading.frozen_candidate_cohorts c
        JOIN trading.frozen_candidate_manifests m ON m.id = c.manifest_id
        WHERE c.scanner_identity = $1
          AND c.status = 'ACTIVE'
        ORDER BY c.started_at DESC
        LIMIT 1
      `,
      [scannerIdentity],
    )) as ManifestRow[];
    return rows[0] ? this.toManifest(rows[0]) : null;
  }

  private assertMatches(
    manifest: FrozenCandidateManifest,
    input: EnsureActiveFrozenCandidateManifestInput,
    expectedHash: string,
  ): void {
    const exact =
      manifest.status === 'ACTIVE' &&
      manifest.candidateCode === input.semanticPolicy.candidateCode &&
      manifest.policyVersion === input.semanticPolicy.policyVersion &&
      manifest.gitCommitSha === input.gitCommitSha &&
      manifest.manifestHash === expectedHash;
    if (!exact) {
      throw new FrozenCandidatePolicyMismatchError(
        'An active frozen candidate already exists with different trading semantics; the old cohort is not mutated.',
      );
    }
  }

  private assertInput(input: EnsureActiveFrozenCandidateManifestInput): void {
    if (!input.scannerIdentity.trim()) {
      throw new FrozenCandidatePolicyMismatchError('Frozen candidate scanner identity is required.');
    }
    if (!/^[0-9a-f]{40}$/i.test(input.gitCommitSha)) {
      throw new FrozenCandidatePolicyMismatchError('Frozen candidate git commit SHA must be exact.');
    }
    if (
      input.semanticPolicy.candidateCode !== UNIFIED_FROZEN_CANDIDATE_CODE ||
      input.semanticPolicy.policyVersion !== UNIFIED_FROZEN_POLICY_VERSION
    ) {
      throw new FrozenCandidatePolicyMismatchError(
        'Frozen candidate semantic policy identity does not match the compiled candidate.',
      );
    }
  }

  private toManifest(row: ManifestRow): FrozenCandidateManifest {
    const semanticPolicy =
      typeof row.semantic_policy === 'string'
        ? (JSON.parse(row.semantic_policy) as FrozenCandidateSemanticPolicy)
        : row.semantic_policy;
    return {
      id: row.id,
      cohortId: row.cohort_id ?? null,
      scannerIdentity: row.scanner_identity,
      candidateCode: row.candidate_code,
      policyVersion: row.policy_version,
      gitCommitSha: row.git_commit_sha,
      semanticPolicy,
      manifestHash: row.manifest_hash,
      deploymentTimestamp: new Date(row.deployment_timestamp),
      freezeTimestamp: new Date(row.freeze_timestamp),
      status: row.status,
      interruptionReason: row.interruption_reason,
    };
  }
}
