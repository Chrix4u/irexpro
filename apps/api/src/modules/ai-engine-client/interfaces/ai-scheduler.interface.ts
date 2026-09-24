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
  brokerId?: string;
  researchUat?: boolean;
  replayStepsPerCycle?: number;
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
  research_uat?: boolean;
  replay_steps_per_cycle?: number;
  replay_steps_last_cycle?: number;
  replay_steps_total?: number;
  signals_published_total?: number;
  last_strategy_outcome?: string | null;
  last_strategy_reason?: string | null;
  last_trade_id?: string | null;
  executions_succeeded_total?: number;
  downstream_rejected_total?: number;
}

export interface AiSchedulerSessionRegistration {
  registered: boolean;
  trading_session_id: string;
  message: string;
}
