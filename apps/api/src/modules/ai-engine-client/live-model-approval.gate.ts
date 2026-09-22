import { Injectable, Logger } from '@nestjs/common';
import { AiEngineClient } from './ai-engine-client.service';
import type { AiActiveModelStatus } from './interfaces/ai-scheduler.interface';

/**
 * October UAT hardening (WS3) — exact-model LIVE approval gate.
 *
 * The audit found the API-side LIVE model approval coarse: the trading
 * runtime blocked LIVE automation wholesale with 'model_not_approved_for_live'
 * without consulting the AI runtime's EXACT active model. This gate closes
 * that gap: LIVE new exposure requires evidence that the EXACT model active
 * in the AI runtime holds a valid LIVE promotion/approval record.
 *
 * SEPARATION INVARIANTS (never collapsed):
 * 1. research qualification  — the six-pair research gates (untouched here);
 * 2. PAPER approval          — approved_for_paper on the artifact (independent);
 * 3. broker LIVE certification — provider-backed evidence (separate NestJS gate);
 * 4. AI model LIVE approval  — THIS gate (promotion record for the exact artifact);
 * 5. runtime LIVE enablement — engine env gate + explicit connection enablement.
 *
 * A different previously approved model NEVER authorizes the currently active
 * model (the promotion record binds model_version + artifact_sha256 — the
 * engine recomputes the artifact hash on every check). A PAPER-approved model
 * NEVER becomes LIVE-approved automatically. There are ZERO valid LIVE-approved
 * models unless genuine operator-authored promotion evidence exists.
 */

/** Machine reason codes (stable; surfaced in risk rejections + audits + UI). */
export enum LiveModelGateReasonCode {
  /** The AI runtime reports no trained model active. */
  MODEL_NOT_TRAINED = 'MODEL_NOT_TRAINED',
  /** The active model's exact version/artifact identity cannot be established. */
  MODEL_IDENTITY_UNKNOWN = 'MODEL_IDENTITY_UNKNOWN',
  /** No valid LIVE promotion record binds the exact active artifact. */
  MODEL_LIVE_APPROVAL_MISSING = 'MODEL_LIVE_APPROVAL_MISSING',
  /**
   * A previously valid promotion record was withdrawn/invalidated (record
   * removed or invalidated — re-validation fails after prior activation).
   */
  MODEL_LIVE_APPROVAL_REVOKED = 'MODEL_LIVE_APPROVAL_REVOKED',
  /** The active artifact's integrity does not match its recorded identity. */
  MODEL_ARTIFACT_MISMATCH = 'MODEL_ARTIFACT_MISMATCH',
  /** The engine-side environment/config LIVE authorization is not enabled. */
  LIVE_MODEL_ENV_DISABLED = 'LIVE_MODEL_ENV_DISABLED',
  /** The AI runtime could not be reached — model truth cannot be established. */
  MODEL_RUNTIME_UNAVAILABLE = 'MODEL_RUNTIME_UNAVAILABLE',
}

/** The typed decision consumed by the LIVE gates + the readiness surface. */
export interface LiveModelApprovalDecision {
  /** True ONLY when the exact active model is live-approved AND env-enabled. */
  approved: boolean;
  /** Null when approved; otherwise the typed blocking reason. */
  reasonCode: LiveModelGateReasonCode | null;
  /** Safe human-readable detail (no secrets, no raw engine payloads). */
  detail: string;
  /** The exact model identity evidence the decision bound to. */
  model: {
    version: string | null;
    mode: string | null;
    artifactSha256: string | null;
    /** Engine's own paper-approval flag (independent evidence class). */
    approvedForPaper: boolean | null;
  };
  /** Promotion-record identity when a valid record bound the exact model. */
  promotionRecord: {
    recordId: string;
    approvedBy: string | null;
    activatedAt: string | null;
  } | null;
}

/** Engine live_activation.reason → typed gate reason mapping. */
const ACTIVATION_REASON_MAP: Readonly<Record<string, LiveModelGateReasonCode>> = Object.freeze({
  NO_ACTIVE_MODEL: LiveModelGateReasonCode.MODEL_NOT_TRAINED,
  MODEL_NOT_REGISTERED: LiveModelGateReasonCode.MODEL_IDENTITY_UNKNOWN,
  NO_VERIFIED_ARTIFACT: LiveModelGateReasonCode.MODEL_ARTIFACT_MISMATCH,
  ARTIFACT_FILE_MISSING: LiveModelGateReasonCode.MODEL_ARTIFACT_MISMATCH,
  ARTIFACT_SHA_MISMATCH: LiveModelGateReasonCode.MODEL_ARTIFACT_MISMATCH,
  NO_VALID_PROMOTION_RECORD: LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_MISSING,
  PROMOTION_RECORD_REVOKED: LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_REVOKED,
});

@Injectable()
export class LiveModelApprovalGateService {
  private readonly logger = new Logger(LiveModelApprovalGateService.name);

  constructor(private readonly aiEngineClient: AiEngineClient) {}

  /**
   * Evaluate LIVE approval for the EXACT model active in the AI runtime.
   *
   * FAIL-CLOSED on every unprovable step:
   * - engine unreachable / scheduler integration disabled → MODEL_RUNTIME_UNAVAILABLE;
   * - no active model (or a placeholder with no trained artifact) → MODEL_NOT_TRAINED;
   * - identity (version/artifact hash) missing → MODEL_IDENTITY_UNKNOWN;
   * - engine env gate closed → LIVE_MODEL_ENV_DISABLED;
   * - live_activation not activated → the mapped typed reason
   *   (MISSING / REVOKED / ARTIFACT_MISMATCH / …).
   */
  async evaluateActiveModelLiveApproval(): Promise<LiveModelApprovalDecision> {
    let status: AiActiveModelStatus;
    if (!this.aiEngineClient.isSchedulerIntegrationEnabled()) {
      return this.notApproved(
        LiveModelGateReasonCode.MODEL_RUNTIME_UNAVAILABLE,
        'The AI runtime integration is not enabled — model truth cannot be established (fail-closed).',
        null,
      );
    }
    try {
      status = await this.aiEngineClient.getActiveModelStatus();
    } catch (err) {
      this.logger.warn(`LIVE model gate: active-model read failed — ${(err as Error).message}`);
      return this.notApproved(
        LiveModelGateReasonCode.MODEL_RUNTIME_UNAVAILABLE,
        'The AI runtime could not be reached — model truth cannot be established (fail-closed).',
        null,
      );
    }

    const model = {
      version: status.version,
      mode: status.mode,
      artifactSha256: status.artifact_sha256,
      approvedForPaper: status.approved_for_paper,
    };

    // No trained model active in the runtime.
    if (status.loaded === false || !status.version || !status.artifact_sha256) {
      const noArtifact = status.loaded !== false && !status.artifact_sha256;
      return this.notApproved(
        noArtifact
          ? LiveModelGateReasonCode.MODEL_IDENTITY_UNKNOWN
          : LiveModelGateReasonCode.MODEL_NOT_TRAINED,
        noArtifact
          ? 'The active model\u2019s artifact identity cannot be established — LIVE approval cannot bind to it (fail-closed).'
          : 'No trained AI model is active in the runtime — LIVE approval requires an exact trained model.',
        status,
      );
    }

    // Engine-side environment/config LIVE authorization.
    if (status.live_signal_mode_enabled !== true) {
      return this.notApproved(
        LiveModelGateReasonCode.LIVE_MODEL_ENV_DISABLED,
        'The AI engine\u2019s live signal mode is not enabled — no LIVE model path exists for this deployment (fail-closed).',
        status,
      );
    }

    // Exact-model live activation (promotion record re-validated engine-side).
    const activation = status.live_activation;
    if (!activation || !activation.activated) {
      const engineReason = activation?.reason ?? 'NO_VALID_PROMOTION_RECORD';
      const mapped =
        ACTIVATION_REASON_MAP[engineReason] ?? LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_MISSING;
      return this.notApproved(
        mapped,
        mapped === LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_MISSING
          ? `The active AI model has not received LIVE approval (no valid promotion record binds its exact artifact — engine reason: ${engineReason}).`
          : mapped === LiveModelGateReasonCode.MODEL_LIVE_APPROVAL_REVOKED
            ? 'The active AI model\u2019s LIVE approval was withdrawn or invalidated — LIVE trading stays blocked.'
            : `The active AI model\u2019s artifact failed integrity verification (${engineReason}) — LIVE approval cannot bind to it.`,
        status,
      );
    }

    // The record must bind the EXACT active identity (defensive: the engine
    // already guarantees this, but the API side re-verifies the binding).
    if (
      activation.model_version !== status.version ||
      activation.artifact_sha256 !== status.artifact_sha256
    ) {
      return this.notApproved(
        LiveModelGateReasonCode.MODEL_ARTIFACT_MISMATCH,
        'The LIVE promotion record does not bind the exact active model artifact — a different model\u2019s approval never authorizes the active one.',
        status,
      );
    }

    return {
      approved: true,
      reasonCode: null,
      detail:
        'The exact active AI model holds a valid LIVE promotion record and the engine live environment is enabled.',
      model,
      promotionRecord: {
        recordId: activation.record_id ?? 'unknown',
        approvedBy: activation.approved_by,
        activatedAt: activation.activated_at,
      },
    };
  }

  /**
   * LIVE new-exposure assertion: resolves when approved, throws a typed error
   * otherwise. Callers (risk pipeline + final dispatch boundary) translate
   * the typed error into their own rejection surfaces.
   */
  async assertApprovedForLiveNewExposure(): Promise<LiveModelApprovalDecision> {
    const decision = await this.evaluateActiveModelLiveApproval();
    if (!decision.approved) {
      throw new LiveModelNotApprovedError(decision);
    }
    return decision;
  }

  private notApproved(
    reasonCode: LiveModelGateReasonCode,
    detail: string,
    status: AiActiveModelStatus | null,
  ): LiveModelApprovalDecision {
    return {
      approved: false,
      reasonCode,
      detail,
      model: {
        version: status?.version ?? null,
        mode: status?.mode ?? null,
        artifactSha256: status?.artifact_sha256 ?? null,
        approvedForPaper: status?.approved_for_paper ?? null,
      },
      promotionRecord: null,
    };
  }
}

/** Typed block — the LIVE gates translate this into their own surfaces. */
export class LiveModelNotApprovedError extends Error {
  constructor(public readonly decision: LiveModelApprovalDecision) {
    super(decision.detail);
    this.name = 'LiveModelNotApprovedError';
  }
}

/** Lower-snake presentation form (matches the runtime last_reason vocabulary). */
export function liveModelGateReasonToRuntimeReason(code: LiveModelGateReasonCode): string {
  return code.toLowerCase();
}
