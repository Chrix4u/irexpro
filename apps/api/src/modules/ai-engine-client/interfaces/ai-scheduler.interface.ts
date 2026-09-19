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
  confidence_threshold: number | null;
  last_model_evaluated_at?: string | null;
  model_version?: string | null;
  model_mode?: string | null;
  model_loaded?: boolean;
  market_data_cache_status?: string | null;
  market_data_cache_age_seconds?: number | null;
  latest_market_data_at?: string | null;
  market_data_age_seconds?: number | null;
  last_publish_failed: boolean;
}

export interface AiSchedulerSessionRegistration {
  registered: boolean;
  trading_session_id: string;
  message: string;
}
