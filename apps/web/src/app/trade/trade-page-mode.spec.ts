import type { FxMarketSchedule } from '@irexpro/types/market-schedule';
import { resolveTradePageMode } from './trade-page-mode';

const closed: FxMarketSchedule = {
  paused: true,
  reason: 'WEEKEND',
  nextEligibleScanAt: '2026-10-25T21:00:00.000Z',
};
const open: FxMarketSchedule = {
  paused: false,
  reason: null,
  nextEligibleScanAt: '2026-10-26T10:05:00.000Z',
};

describe('trade page first-render mode', () => {
  it('renders market closed before auth restoration can show generic/default UI', () => {
    expect(resolveTradePageMode({ schedule: closed, restoring: true, hasUser: false })).toBe(
      'MARKET_CLOSED',
    );
  });

  it('uses restoring state when the server says the market is open', () => {
    expect(resolveTradePageMode({ schedule: open, restoring: true, hasUser: false })).toBe(
      'RESTORING',
    );
  });

  it('renders signed-out and workspace modes after auth restoration', () => {
    expect(resolveTradePageMode({ schedule: open, restoring: false, hasUser: false })).toBe(
      'SIGNED_OUT',
    );
    expect(resolveTradePageMode({ schedule: open, restoring: false, hasUser: true })).toBe(
      'WORKSPACE',
    );
  });
});
