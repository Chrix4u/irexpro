import { LiveModelNotApprovedError } from './live-model-approval.gate';
import { LiveModelApprovalGateService, LiveModelGateReasonCode } from './live-model-approval.gate';
import type { AiEngineClient } from './ai-engine-client.service';
import type { AiActiveModelStatus } from './interfaces/ai-scheduler.interface';

/**
 * October UAT hardening (WS3) — the exact-model LIVE approval gate.
 *
 * Separation invariants under test:
 * - research qualification / PAPER approval NEVER satisfy the LIVE gate;
 * - a different previously approved model NEVER authorizes the active model;
 * - an unreachable runtime is fail-closed (never a skip);
 * - the promotion record must bind the EXACT active version + artifact hash.
 */
describe('LiveModelApprovalGateService (WS3 exact-model gate)', () => {
  let gate: LiveModelApprovalGateService;
  let aiEngineClient: {
    isSchedulerIntegrationEnabled: jest.Mock;
    getActiveModelStatus: jest.Mock;
  };

  const activeStatus = (overrides: Partial<AiActiveModelStatus> = {}): AiActiveModelStatus => ({
    version: 'xgb-mtf-2026.09',
    mode: 'trained_xgboost_mtf',
    loaded: true,
    artifact_sha256: 'a'.repeat(64),
    approved_for_paper: true,
    approved_for_live: false,
    live_activation: {
      activated: true,
      record_id: 'record-1',
      model_version: 'xgb-mtf-2026.09',
      artifact_sha256: 'a'.repeat(64),
      promoted_by: 'ml-ops',
      approved_by: 'compliance',
      activated_at: '2026-09-01T00:00:00Z',
      reason: null,
    },
    live_signal_mode_enabled: true,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    aiEngineClient = {
      isSchedulerIntegrationEnabled: jest.fn().mockReturnValue(true),
      getActiveModelStatus: jest.fn(),
    };
    gate = new LiveModelApprovalGateService(aiEngineClient as unknown as AiEngineClient);
  });

  // ─── Approved ─────────────────────────────────────────────────────────────

  it('the EXACT active approved model is accepted (version + artifact binding verified)', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(activeStatus());
    const decision = await gate.evaluateActiveModelLiveApproval();

    expect(decision.approved).toBe(true);
    expect(decision.reasonCode).toBeNull();
    expect(decision.model.version).toBe('xgb-mtf-2026.09');
    expect(decision.model.artifactSha256).toBe('a'.repeat(64));
    expect(decision.promotionRecord?.recordId).toBe('record-1');
  });

  it('assertApprovedForLiveNewExposure resolves when approved', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(activeStatus());
    await expect(gate.assertApprovedForLiveNewExposure()).resolves.toEqual(
      expect.objectContaining({ approved: true }),
    );
  });

  // ─── Runtime unavailable (fail-closed) ────────────────────────────────────

  it('scheduler integration disabled → MODEL_RUNTIME_UNAVAILABLE (fail-closed)', async () => {
    aiEngineClient.isSchedulerIntegrationEnabled.mockReturnValue(false);
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.approved).toBe(false);
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_RUNTIME_UNAVAILABLE);
  });

  it('engine unreachable → MODEL_RUNTIME_UNAVAILABLE (never a skip)', async () => {
    aiEngineClient.getActiveModelStatus.mockRejectedValue(new Error('ECONNREFUSED'));
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.approved).toBe(false);
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_RUNTIME_UNAVAILABLE);
  });

  // ─── No trained model / identity unknown ─────────────────────────────────

  it('no active model in the runtime → MODEL_NOT_TRAINED', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({
        loaded: false,
        version: null,
        artifact_sha256: null,
        live_activation: null,
        live_signal_mode_enabled: true,
      }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_NOT_TRAINED);
  });

  it('an active model without artifact identity → MODEL_IDENTITY_UNKNOWN', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({
        artifact_sha256: null,
        live_activation: null,
      }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_IDENTITY_UNKNOWN);
  });

  // ─── Environment/config authorization ────────────────────────────────────

  it('engine live signal mode disabled → LIVE_MODEL_ENV_DISABLED even with a valid record', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({ live_signal_mode_enabled: false }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.approved).toBe(false);
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.LIVE_MODEL_ENV_DISABLED);
  });

  // ─── Missing / mismatched / revoked approval ─────────────────────────────

  it('no valid promotion record → MODEL_LIVE_APPROVAL_MISSING (paper approval never substitutes)', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({
        live_activation: {
          activated: false,
          record_id: null,
          model_version: null,
          artifact_sha256: null,
          promoted_by: null,
          approved_by: null,
          activated_at: null,
          reason: 'NO_VALID_PROMOTION_RECORD',
        },
      }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.approved).toBe(false);
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_MISSING);
    expect(decision.model.approvedForPaper).toBe(true); // paper approval did NOT authorize
  });

  it('a revoked promotion record → MODEL_LIVE_APPROVAL_REVOKED', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({
        live_activation: {
          activated: false,
          record_id: null,
          model_version: null,
          artifact_sha256: null,
          promoted_by: null,
          approved_by: null,
          activated_at: null,
          reason: 'PROMOTION_RECORD_REVOKED',
        },
      }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_REVOKED);
  });

  it('artifact integrity failure → MODEL_ARTIFACT_MISMATCH', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({
        live_activation: {
          activated: false,
          record_id: null,
          model_version: null,
          artifact_sha256: null,
          promoted_by: null,
          approved_by: null,
          activated_at: null,
          reason: 'ARTIFACT_SHA_MISMATCH',
        },
      }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_ARTIFACT_MISMATCH);
  });

  it('a record binding a DIFFERENT model never authorizes the active model (identity mismatch)', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({
        // The record binds a different version than the active model.
        live_activation: {
          activated: true,
          record_id: 'record-old',
          model_version: 'xgb-mtf-2025.01',
          artifact_sha256: 'a'.repeat(64),
          promoted_by: 'ml-ops',
          approved_by: 'compliance',
          activated_at: '2025-01-01T00:00:00Z',
          reason: null,
        },
      }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.approved).toBe(false);
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_ARTIFACT_MISMATCH);
    expect(decision.detail).toContain('never authorizes the active one');
  });

  it('a record binding a different ARTIFACT HASH never authorizes the active artifact', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({
        live_activation: {
          activated: true,
          record_id: 'record-1',
          model_version: 'xgb-mtf-2026.09',
          artifact_sha256: 'b'.repeat(64),
          promoted_by: 'ml-ops',
          approved_by: 'compliance',
          activated_at: '2026-09-01T00:00:00Z',
          reason: null,
        },
      }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.approved).toBe(false);
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_ARTIFACT_MISMATCH);
  });

  it('a malformed engine payload collapses to honest nulls — never a fabricated pass', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({ live_activation: null, live_signal_mode_enabled: null }),
    );
    const decision = await gate.evaluateActiveModelLiveApproval();
    expect(decision.approved).toBe(false);
    expect(decision.reasonCode).toBe(LiveModelGateReasonCode.LIVE_MODEL_ENV_DISABLED);
  });

  // ─── Assertion surface ───────────────────────────────────────────────────

  it('the LIVE assertion throws the typed error with the decision for downstream gates', async () => {
    aiEngineClient.getActiveModelStatus.mockResolvedValue(
      activeStatus({
        live_activation: {
          activated: false,
          record_id: null,
          model_version: null,
          artifact_sha256: null,
          promoted_by: null,
          approved_by: null,
          activated_at: null,
          reason: 'NO_VALID_PROMOTION_RECORD',
        },
      }),
    );
    await expect(gate.assertApprovedForLiveNewExposure()).rejects.toBeInstanceOf(
      LiveModelNotApprovedError,
    );
    try {
      await gate.assertApprovedForLiveNewExposure();
    } catch (err) {
      const blocked = err as LiveModelNotApprovedError;
      expect(blocked.decision.reasonCode).toBe(LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_MISSING);
    }
  });
});
