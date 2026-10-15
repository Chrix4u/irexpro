import fs from 'node:fs';
import path from 'node:path';

describe('AI Trading execution visibility contract', () => {
  const source = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');

  it('shows recent executed trade evidence in the top trading snapshot even when no position is currently open', () => {
    expect(source).toContain('Recent executed trades');
    expect(source).toContain('recentExecutedTrades.length');
    expect(source).toContain('Latest completed');
    expect(source).toContain('latestClosedTrade');
  });
});
