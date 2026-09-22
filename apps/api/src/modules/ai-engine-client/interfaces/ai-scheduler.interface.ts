import { BrokerMode } from '../../broker/interfaces/broker-adapter.interface';
import { ExecutionMode } from '../../execution/interfaces/execution-authority';

export interface AiSchedulerSessionStartPayload {
  userId: string;
  tradingSessionId: string;
  brokerConnectionId: string;
  instruments: string[];
  timeframe: string;
  intervalSeconds?: number;
  source: 'broker' | 'mock';
  /**
   * Exact environment of the bound broker connection. FULL_AUTO on DEMO is
   * still demo execution; LIVE remains blocked by the paper-approved AI
   * scheduler until a separately live-approved model path exists.
   */
  accountType: BrokerMode;
  /**
   * The session's durable execution mode (Round 5, #298) — NOT a hardcoded
   * 'paper' literal. The AI engine still only generates paper-mode signals; the
   * risk + execution gates remain the enforcement boundary.
   */
  mode: ExecutionMode;
}

export interface AiSchedulerSessionStopPayload {
  tradingSessionId: string;
}

export interface AiSchedulerSessionStatus {
  enabled: boolean;
  registered: boolean;
  trading_session_id: string;
  active: boolean;
  instruments: string[];
  timeframe: string | null;
  interval_seconds: number | null;
  source: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_decision: string | null;
  last_reason: string | null;
  last_confidence_score: number | null;
  last_confidence_at: string | null;
  confidence_threshold: number | null;
  model_version: string | null;
  model_mode: string | null;
  model_loaded: boolean | null;
  last_market_data_at: string | null;
  market_data_age_seconds: number | null;
  market_data_cache_bypassed: boolean;
  last_publish_failed: boolean;
}

export interface AiSchedulerSessionRegistration {
  registered: boolean;
  trading_session_id: string;
  message: string;
  /**
   * October UAT hardening (WS3): the exact typed refusal reason for LIVE-bound
   * session registration (e.g. 'LIVE_MODEL_ENV_DISABLED',
   * 'NO_VALID_PROMOTION_RECORD', 'MODEL_NOT_REGISTERED',
   * 'ARTIFACT_SHA_MISMATCH'). Absent/null on success or for older payloads.
   */
  reason?: string | null;
}

/**
 * GET /models/active — the ACTIVE model truth from the AI runtime
 * (re-validated per call on the engine side). `live_activation` is the
 * fail-closed promotion-record evaluation for the EXACT active artifact;
 * `live_signal_mode_enabled` is the engine-side environment/config LIVE
 * authorization. Never cached: every read re-fetches current truth.
 */
export interface AiActiveModelStatus {
  /** Active model version identifier (engine-reported). */
  version: string | null;
  /** Engine model mode (e.g. 'trained_xgboost_mtf', 'heuristic_placeholder'). */
  mode: string | null;
  /** Whether the engine reports a model loaded in the runtime. */
  loaded: boolean | null;
  /** Byte-exact artifact identity — the promotion record binds THIS value. */
  artifact_sha256: string | null;
  /** Paper approval of the active artifact (independent evidence class). */
  approved_for_paper: boolean | null;
  /** Always false from the engine's trained-model governance. */
  approved_for_live: boolean | null;
  /** The fail-closed live-activation evaluation for the exact active model. */
  live_activation: {
    activated: boolean;
    record_id: string | null;
    model_version: string | null;
    artifact_sha256: string | null;
    promoted_by: string | null;
    approved_by: string | null;
    activated_at: string | null;
    reason: string | null;
  } | null;
  /** Engine-side environment/config LIVE authorization (env gate). */
  live_signal_mode_enabled: boolean | null;
}
