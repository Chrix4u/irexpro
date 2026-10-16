import {
  adaptiveCandidateRiskAtStop,
  adaptiveMarketDataFreshness,
  rankAdaptivePaperScanWinners,
} from './adaptive-paper-authority';

describe('adaptive PAPER authority helpers', () => {
  it('derives a conservative risk-at-stop proxy from explicit PAPER allocation', () => {
    expect(adaptiveCandidateRiskAtStop('1000', 2)).toBe(20);
    expect(adaptiveCandidateRiskAtStop('1000', 1)).toBe(10);
    expect(adaptiveCandidateRiskAtStop(null, 2)).toBeNull();
    expect(adaptiveCandidateRiskAtStop('bad', 2)).toBeNull();
  });

  it('classifies a recently closed M5 bar as fresh and stale evidence conservatively', () => {
    const barClose = new Date('2026-10-15T18:45:00Z');
    expect(adaptiveMarketDataFreshness(barClose, new Date('2026-10-15T18:50:30Z'))).toBe('FRESH');
    expect(adaptiveMarketDataFreshness(barClose, new Date('2026-10-15T19:01:00Z'))).toBe('STALE');
    expect(adaptiveMarketDataFreshness(new Date('invalid'), new Date())).toBe('UNKNOWN');
  });

  it('ranks the entire scan by adaptive score then authoritative net edge', () => {
    const ranked = rankAdaptivePaperScanWinners([
      { id: 'EURUSD', adaptiveScore: 0.71, netExpectedR: 0.2 },
      { id: 'USDJPY', adaptiveScore: 0.83, netExpectedR: 0.12 },
      { id: 'GBPUSD', adaptiveScore: 0.83, netExpectedR: 0.19 },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(['GBPUSD', 'USDJPY', 'EURUSD']);
    expect(ranked.map((item) => item.adaptiveScanRank)).toEqual([1, 2, 3]);
  });

  it('never manufactures a winner when no pair produced an executable route', () => {
    expect(rankAdaptivePaperScanWinners([])).toEqual([]);
  });
});
