import { ExecutionMode } from '../../execution/interfaces/execution-authority';

export interface AiSchedulerSessionStartPayload {
  userId: string;
  tradingSessionId: string;
  brokerConnectionId: string;
  instruments: string[];
  timeframe: string;
  timeframes?: string[];
  intervalSeconds?: number;
  source: 'broker' | 'mock';
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

export type AiSchedulerDecision =
  | 'WAITING_FOR_FIRST_SCAN'
  | 'NO_SIGNAL'
  | 'SIGNAL_PUBLISHED'
  | 'LIVE_MODEL_BLOCKED'
  | 'ERROR';

export interface AiSchedulerRegistrationResponse {
  registered: boolean;
  trading_session_id: string;
  message: string;
}

export interface AiSchedulerJobStatus {
  trading_session_id: string;
  active: boolean;
  execution_mode: string;
  instruments: string[];
  timeframes: string[];
  interval_seconds: number;
  registered_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  scan_count: number;
  last_decision: AiSchedulerDecision;
  last_reason: string | null;
  last_instrument: string | null;
  last_timeframe: string | null;
  last_confidence_score: number | null;
  confidence_threshold: number | null;
  last_signal_id: string | null;
}

export interface AiSchedulerSessionStatus {
  scheduler_enabled: boolean;
  scheduler_running: boolean;
  registered: boolean;
  active_model_version: string | null;
  approved_for_live: boolean | null;
  job: AiSchedulerJobStatus | null;
}
