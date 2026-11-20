import fs from 'node:fs';
import path from 'node:path';

describe('bidirectional historical feature drift explanation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');

  it('shows each exact historical feature-range violation without altering trading controls', () => {
    expect(source).toContain('Exact out-of-distribution diagnostics');
    expect(source).toContain('readableDriftDiagnostic(detail)');
    expect(source).toContain('Model confidence');
    expect(source).toContain('Directional EMA separation');
    expect(source).toContain('Higher-timeframe trend strength');
    expect(source).toContain('Estimated net return after costs is negative.');
    expect(source).toContain('This direction also failed model admission separately.');
  });

  it('does not confuse paired M5 research results with real M1 broker orders', () => {
    expect(source).toContain('paired BUY and SELL PAPER research decisions');
    expect(source).toContain('M1 reversal/early-transition DEMO trial');
    expect(source).toContain('not broker orders');
  });
});
