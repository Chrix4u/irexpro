import { describeMacroEventBlock } from './paper-trade-blocker';

describe('describeMacroEventBlock', () => {
  it('names the blocking event and the end of its protection window', () => {
    expect(
      describeMacroEventBlock({
        state: 'HIGH_IMPACT_BLOCK',
        blockWindowMinutesAfter: 30,
        blockingEvents: [
          {
            date: '2026-10-14T12:30:00.000Z',
            event: 'US CPI',
          },
        ],
      }),
    ).toBe('US CPI · event 12:30 UTC · protected until 13:00 UTC');
  });

  it('falls back safely when provider evidence omits event details', () => {
    expect(
      describeMacroEventBlock({
        state: 'HIGH_IMPACT_BLOCK',
        blockWindowMinutesAfter: 30,
        blockingEvents: [],
      }),
    ).toBe('High-impact macro event safety window');
  });

  it('returns null when macro risk is clear', () => {
    expect(
      describeMacroEventBlock({
        state: 'CLEAR',
        blockWindowMinutesAfter: 30,
        blockingEvents: [],
      }),
    ).toBeNull();
  });
});
