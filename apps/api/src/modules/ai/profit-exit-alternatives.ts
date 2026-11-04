/** Read-only comparison of early close, protected runner and partial close.
 * No broker order is created or modified by this module.
 */
export const EXIT_ALTERNATIVES_ARTIFACT = 'exit-alternatives-verified-m1-v1';
export type ExitOutcome = 'TP_FIRST' | 'STOP_FIRST' | 'AMBIGUOUS' | 'DATA_GAP' | 'UNRESOLVED' | 'INELIGIBLE';

export interface ExitCandle {
  bucket_time: Date | string;
  high: number | string;
  low: number | string;
  sample_count: number | string;
  positive_quote_sample_count: number | string;
  last_quote_sample_at: Date | string | null;
  source: string;
}
export interface ExitScenario {
  outcome: ExitOutcome;
  eventAt: string | null;
  observedBars: number;
  netPnlProxy: number | null;
  deltaVsOriginal: number | null;
}
export interface ExitScenarioInput {
  direction: 'BUY' | 'SELL';
  closeAt: Date;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  runnerStopPrice: number | null;
  runnerEligible: boolean;
  grossPnl: number;
  commission: number;
  swap: number;
  candles: ExitCandle[];
}
