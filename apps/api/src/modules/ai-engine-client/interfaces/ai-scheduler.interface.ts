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
