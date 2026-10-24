import type { FxMarketSchedule } from '@irexpro/types/market-schedule';

export type TradePageMode = 'MARKET_CLOSED' | 'RESTORING' | 'SIGNED_OUT' | 'WORKSPACE';

export function resolveTradePageMode(input: {
  schedule: FxMarketSchedule;
  restoring: boolean;
  hasUser: boolean;
}): TradePageMode {
  if (input.schedule.paused && input.schedule.reason === 'WEEKEND') return 'MARKET_CLOSED';
  if (input.restoring) return 'RESTORING';
  if (!input.hasUser) return 'SIGNED_OUT';
  return 'WORKSPACE';
}
