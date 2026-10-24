import {
  buildAdaptiveShadowDirectionalPulse,
  type AdaptiveShadowDirectionalOutcome,
} from './adaptive-shadow-directional-pulse';

const evaluatedAt = new Date('2026-10-23T19:30:00.000Z');

function outcome(
  direction: 'BUY' | 'SELL',
  netR: number,
  resolvedAt: string,
): AdaptiveShadowDirectionalOutcome {
  return { direction, netR, resolvedAt };
}

describe('adaptive shadow directional pulse', () => {
  it('uses only outcomes resolved before evaluation and supports the paying side', () => {
    const outcomes: AdaptiveShadowDirectionalOutcome[] = [
      outcome('BUY', 1.4, '2026-10-23T18:00:00.000Z'),
      outcome('BUY', 1.2, '2026-10-23T18:20:00.000Z'),
      outcome('BUY', 1.5, '2026-10-23T18:40:00.000Z'),
      outcome('BUY', 1.3, '2026-10-23T19:00:00.000Z'),
      outcome('SELL', -1.0, '2026-10-23T18:05:00.000Z'),
      outcome('SELL', -1.2, '2026-10-23T18:25:00.000Z'),
      outcome('SELL', -1.1, '2026-10-23T18:45:00.000Z'),
      outcome('SELL', -1.3, '2026-10-23T19:05:00.000Z'),
      // This very large future loss must not contaminate the current BUY pulse.
      outcome('BUY', -20, '2026-10-23T19:45:00.000Z'),
    ];

    const buy = buildAdaptiveShadowDirectionalPulse({
      direction: 'BUY',
      evaluatedAt,
      outcomes,
    });
    const sell = buildAdaptiveShadowDirectionalPulse({
      direction: 'SELL',
      evaluatedAt,
      outcomes,
    });

    expect(buy.available).toBe(true);
    expect(buy.candidateSamples).toBe(4);
    expect(buy.oppositeSamples).toBe(4);
    expect(buy.status).toBe('SUPPORTED');
    expect(buy.quality).toBeGreaterThan(0.75);
    expect(buy.advantageR).toBeGreaterThan(2);

    expect(sell.available).toBe(true);
    expect(sell.status).toBe('OPPOSED');
    expect(sell.quality).toBeLessThan(0.25);
    expect(sell.advantageR).toBeLessThan(-2);
  });

  it('returns a neutral pulse when either side has fewer than four resolved samples', () => {
    const result = buildAdaptiveShadowDirectionalPulse({
      direction: 'BUY',
      evaluatedAt,
      outcomes: [
        outcome('BUY', 1, '2026-10-23T18:00:00.000Z'),
        outcome('BUY', 1, '2026-10-23T18:10:00.000Z'),
        outcome('BUY', 1, '2026-10-23T18:20:00.000Z'),
        outcome('SELL', -1, '2026-10-23T18:05:00.000Z'),
        outcome('SELL', -1, '2026-10-23T18:15:00.000Z'),
        outcome('SELL', -1, '2026-10-23T18:25:00.000Z'),
        outcome('SELL', -1, '2026-10-23T18:35:00.000Z'),
      ],
    });

    expect(result.available).toBe(false);
    expect(result.status).toBe('INSUFFICIENT');
    expect(result.quality).toBe(0.5);
    expect(result.candidateSamples).toBe(3);
    expect(result.oppositeSamples).toBe(4);
  });

  it('uses only the latest ten resolved outcomes on each side', () => {
    const outcomes: AdaptiveShadowDirectionalOutcome[] = [];
    for (let index = 0; index < 14; index += 1) {
      const minute = String(index).padStart(2, '0');
      outcomes.push(outcome('BUY', index < 4 ? -10 : 1, `2026-10-23T18:${minute}:00.000Z`));
      outcomes.push(outcome('SELL', -1, `2026-10-23T18:${minute}:30.000Z`));
    }

    const result = buildAdaptiveShadowDirectionalPulse({ direction: 'BUY', evaluatedAt, outcomes });

    expect(result.candidateSamples).toBe(10);
    expect(result.oppositeSamples).toBe(10);
    expect(result.candidateWeightedR).toBeGreaterThan(0.9);
    expect(result.quality).toBeGreaterThan(0.75);
  });
});
