import {
  evaluatePaperPostLossEntryGuard,
  PaperPostLossEntryState,
} from './paper-post-loss-entry-guard';

const lastClosedAt = new Date('2026-10-12T07:01:12.021Z');
const state: PaperPostLossEntryState = {
  available: true,
  lastClosedTrade: {
    id: 'loss-1',
    closeReason: 'STOP_LOSS_HIT',
    closedAt: lastClosedAt,
    reconfirmed: false,
  },
};
const base = {
  state,
  marketBarOpenedAt: new Date('2026-10-12T07:05:00Z'),
  evaluatedAt: new Date('2026-10-12T07:10:12Z'),
  alignedMomentumAtr: 0.8,
};

describe('PAPER post-stop-loss entry confirmation', () => {
  it('allows an initial entry with proven empty history', () => {
    expect(
      evaluatePaperPostLossEntryGuard({
        ...base,
        state: { available: true, lastClosedTrade: null },
      }),
    ).toMatchObject({ eligible: true, reason: 'NO_PREVIOUS_CLOSE' });
  });
  it('does not throttle entries after a non-stop-loss close', () => {
    expect(
      evaluatePaperPostLossEntryGuard({
        ...base,
        alignedMomentumAtr: -0.2,
        state: {
          ...state,
          lastClosedTrade: { ...state.lastClosedTrade!, closeReason: 'PROFIT_PROTECTION' },
        },
      }),
    ).toMatchObject({ eligible: true, reason: 'LAST_CLOSE_NOT_STOP_LOSS' });
  });
  it('blocks the observed 07:05 re-entry because its bar began before the loss', () => {
    expect(
      evaluatePaperPostLossEntryGuard({
        ...base,
        marketBarOpenedAt: new Date('2026-10-12T07:00:00Z'),
        evaluatedAt: new Date('2026-10-12T07:05:13Z'),
        alignedMomentumAtr: -1.569,
      }),
    ).toMatchObject({ eligible: false, reason: 'WAITING_FOR_POST_LOSS_BAR' });
  });
  it('requires a fully post-loss bar even if its momentum is favorable', () => {
    expect(
      evaluatePaperPostLossEntryGuard({
        ...base,
        marketBarOpenedAt: new Date('2026-10-12T07:00:00Z'),
      }),
    ).toMatchObject({ eligible: false, reason: 'WAITING_FOR_POST_LOSS_BAR' });
  });
  it.each([-0.8, 0])(
    'blocks momentum %s that has not renewed directional support',
    (alignedMomentumAtr) => {
      expect(evaluatePaperPostLossEntryGuard({ ...base, alignedMomentumAtr })).toMatchObject({
        eligible: false,
        reason: 'DIRECTION_NOT_RECONFIRMED',
      });
    },
  );
  it('permits renewed direction without a fixed cooldown or entry cap', () => {
    expect(evaluatePaperPostLossEntryGuard(base)).toMatchObject({
      eligible: true,
      reason: 'DIRECTION_RECONFIRMED',
      lastClosedTradeId: 'loss-1',
    });
  });
  it('does not impose the momentum condition repeatedly after an executed confirmation', () => {
    expect(
      evaluatePaperPostLossEntryGuard({
        ...base,
        alignedMomentumAtr: -0.2,
        state: { ...state, lastClosedTrade: { ...state.lastClosedTrade!, reconfirmed: true } },
      }),
    ).toMatchObject({ eligible: true, reason: 'DIRECTION_ALREADY_RECONFIRMED' });
  });
  it('fails closed when history could not be read', () => {
    expect(
      evaluatePaperPostLossEntryGuard({
        ...base,
        state: { available: false, lastClosedTrade: null },
      }),
    ).toMatchObject({ eligible: false, reason: 'HISTORY_UNAVAILABLE' });
  });
  it('rejects a forming market bar', () => {
    expect(
      evaluatePaperPostLossEntryGuard({ ...base, evaluatedAt: new Date('2026-10-12T07:09:59Z') }),
    ).toMatchObject({ eligible: false, reason: 'INVALID_MARKET_EVIDENCE' });
  });
  it.each([NaN, Infinity])('fails closed on non-finite momentum %s', (alignedMomentumAtr) => {
    expect(evaluatePaperPostLossEntryGuard({ ...base, alignedMomentumAtr })).toMatchObject({
      eligible: false,
      reason: 'INVALID_MARKET_EVIDENCE',
    });
  });
  it('rejects future-dated closure evidence even when marked reconfirmed', () => {
    expect(
      evaluatePaperPostLossEntryGuard({
        ...base,
        state: {
          ...state,
          lastClosedTrade: {
            ...state.lastClosedTrade!,
            closedAt: new Date('2026-10-12T07:15:00Z'),
            reconfirmed: true,
          },
        },
      }),
    ).toMatchObject({ eligible: false, reason: 'INVALID_CLOSE_EVIDENCE' });
  });
});
