import type { DataSource } from 'typeorm';
import {
  UNIFIED_FROZEN_CANDIDATE_CODE,
  UNIFIED_FROZEN_POLICY_VERSION,
  type FrozenCandidateSemanticPolicy,
} from './unified-frozen-candidate';
import {
  FrozenCandidateManifestService,
  FrozenCandidatePolicyMismatchError,
  hashFrozenCandidateSemanticPolicy,
} from './frozen-candidate-manifest.service';

const scannerIdentity = 'vps-paper-six-pair-primary';
const gitCommitSha = 'bab0e57a7d13462fb644b78c5834bca46eb617ff';

function policy(overrides: Partial<FrozenCandidateSemanticPolicy> = {}): FrozenCandidateSemanticPolicy {
  return {
    candidateCode: UNIFIED_FROZEN_CANDIDATE_CODE,
    policyVersion: UNIFIED_FROZEN_POLICY_VERSION,
    instruments: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'],
    entryTimeframes: ['M1', 'M5'],
    contextTimeframes: ['M15', 'H1', 'H4'],
    directionalMarginR: 0.02,
    bootstrapRiskMultiplier: 0.5,
    bootstrapCompletedEpisodes: 10,
    collectingCompletedEpisodes: 20,
    eligibleProfitFactorFloor: 1.15,
    eligibleAverageRFloor: 0,
    selectionLiftFloorR: 0,
    qualificationCheckpointTrades: 50,
    qualificationPreferredTrades: 100,
    researchExecutionQuarantined: true,
    demoLiveAuthority: false,
    expertArtifacts: {
      planB: 'plan-b-multimodel-shadow-v4',
      m1: 'm1-tactical-v1',
      extensionExhaustion: 'extension-exhaustion-shadow-v1',
      donchian: 'donchian-breakout-expert-v1',
    },
    sizingPolicy: 'adaptive-risk-multiplier-v1',
    stopTargetPolicy: 'unified-stop-target-v1',
    postEntryPolicy: 'unified-post-entry-v1',
    costPolicy: 'paper-cost-aware-entry-v1',
    eventRiskPolicy: 'macro-event-risk-v1',
    driftPolicy: 'ensemble-drift-v1',
    episodePolicy: 'selection-episode-v1',
    selectionGovernorPolicy: 'selection-governor-v1',
    ...overrides,
  };
}

function row(hash: string) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    scanner_identity: scannerIdentity,
    candidate_code: UNIFIED_FROZEN_CANDIDATE_CODE,
    policy_version: UNIFIED_FROZEN_POLICY_VERSION,
    git_commit_sha: gitCommitSha,
    semantic_policy: policy(),
    manifest_hash: hash,
    deployment_timestamp: '2026-10-22T12:00:00.000Z',
    freeze_timestamp: '2026-10-22T12:00:00.000Z',
    status: 'ACTIVE',
    interruption_reason: null,
  };
}

describe('FrozenCandidateManifestService', () => {
  it('hashes equivalent semantic policies deterministically regardless of object key order', () => {
    const original = policy();
    const reordered = {
      selectionGovernorPolicy: original.selectionGovernorPolicy,
      episodePolicy: original.episodePolicy,
      driftPolicy: original.driftPolicy,
      eventRiskPolicy: original.eventRiskPolicy,
      costPolicy: original.costPolicy,
      postEntryPolicy: original.postEntryPolicy,
      stopTargetPolicy: original.stopTargetPolicy,
      sizingPolicy: original.sizingPolicy,
      expertArtifacts: {
        donchian: original.expertArtifacts.donchian,
        extensionExhaustion: original.expertArtifacts.extensionExhaustion,
        m1: original.expertArtifacts.m1,
        planB: original.expertArtifacts.planB,
      },
      demoLiveAuthority: original.demoLiveAuthority,
      researchExecutionQuarantined: original.researchExecutionQuarantined,
      qualificationPreferredTrades: original.qualificationPreferredTrades,
      qualificationCheckpointTrades: original.qualificationCheckpointTrades,
      selectionLiftFloorR: original.selectionLiftFloorR,
      eligibleAverageRFloor: original.eligibleAverageRFloor,
      eligibleProfitFactorFloor: original.eligibleProfitFactorFloor,
      collectingCompletedEpisodes: original.collectingCompletedEpisodes,
      bootstrapCompletedEpisodes: original.bootstrapCompletedEpisodes,
      bootstrapRiskMultiplier: original.bootstrapRiskMultiplier,
      directionalMarginR: original.directionalMarginR,
      contextTimeframes: original.contextTimeframes,
      entryTimeframes: original.entryTimeframes,
      instruments: original.instruments,
      policyVersion: original.policyVersion,
      candidateCode: original.candidateCode,
    } satisfies FrozenCandidateSemanticPolicy;

    expect(hashFrozenCandidateSemanticPolicy(original)).toBe(
      hashFrozenCandidateSemanticPolicy(reordered),
    );
  });

  it('changes the manifest hash when any frozen trading semantic changes', () => {
    const baseHash = hashFrozenCandidateSemanticPolicy(policy());
    expect(hashFrozenCandidateSemanticPolicy(policy({ directionalMarginR: 0.03 }))).not.toBe(
      baseHash,
    );
    expect(
      hashFrozenCandidateSemanticPolicy(policy({ bootstrapRiskMultiplier: 0.75 })),
    ).not.toBe(baseHash);
  });

  it('returns the same active manifest on restart without mutating it', async () => {
    const hash = hashFrozenCandidateSemanticPolicy(policy());
    const query = jest.fn().mockResolvedValueOnce([row(hash)]);
    const service = new FrozenCandidateManifestService({ query } as unknown as DataSource);

    const result = await service.ensureActiveManifest({
      scannerIdentity,
      gitCommitSha,
      semanticPolicy: policy(),
      deploymentTimestamp: new Date('2026-10-22T12:00:00.000Z'),
    });

    expect(result.manifestHash).toBe(hash);
    expect(result.status).toBe('ACTIVE');
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]![0])).toContain("c.status = 'ACTIVE'");
  });

  it('fails closed when an active manifest differs instead of mutating the old cohort', async () => {
    const active = row(hashFrozenCandidateSemanticPolicy(policy({ directionalMarginR: 0.03 })));
    active.policy_version = 'irexpro-unified-frozen-v1-policy-old';
    const query = jest.fn().mockResolvedValueOnce([active]);
    const service = new FrozenCandidateManifestService({ query } as unknown as DataSource);

    await expect(
      service.ensureActiveManifest({
        scannerIdentity,
        gitCommitSha,
        semanticPolicy: policy(),
        deploymentTimestamp: new Date('2026-10-22T12:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(FrozenCandidatePolicyMismatchError);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('asserts exact manifest and policy identity for execution and rejects missing evidence', async () => {
    const hash = hashFrozenCandidateSemanticPolicy(policy());
    const query = jest
      .fn()
      .mockResolvedValueOnce([row(hash)])
      .mockResolvedValueOnce([]);
    const service = new FrozenCandidateManifestService({ query } as unknown as DataSource);

    await expect(
      service.assertExecutionPolicy(row(hash).id, UNIFIED_FROZEN_POLICY_VERSION),
    ).resolves.toMatchObject({ manifestHash: hash, status: 'ACTIVE' });

    await expect(
      service.assertExecutionPolicy(row(hash).id, 'wrong-policy'),
    ).rejects.toBeInstanceOf(FrozenCandidatePolicyMismatchError);
  });
});
