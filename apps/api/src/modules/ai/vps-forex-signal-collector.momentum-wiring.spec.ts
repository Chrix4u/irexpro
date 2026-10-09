import { readFileSync } from 'node:fs';

describe('Plan B live momentum wiring', () => {
  it('forwards candidate short-horizon momentum into the Plan B scorer input', () => {
    const source = readFileSync(require.resolve('./vps-forex-signal-collector.service'), 'utf8');
    const scorerCall = source.match(
      /scorePlanBMultimodelShadow\(\s*\{([\s\S]*?)\},\s*portfolioPositions,\s*\)/,
    );

    expect(scorerCall).not.toBeNull();
    expect(scorerCall?.[1]).toContain('shortHorizonMomentumAtr: best.shortHorizonMomentumAtr');
  });
});
