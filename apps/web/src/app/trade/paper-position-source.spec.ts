import fs from 'node:fs';
import path from 'node:path';

describe('AI Trading PAPER position source contract', () => {
  it('renders position state from the PAPER-safe resolver instead of raw live-account rows', () => {
    const source = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');

    expect(source).toContain('resolveAiOpenPositionRows');
    expect(source).toContain('resolveAiOpenPositionRows({');
    expect(source).toContain('positions={aiOpenPositions}');
    expect(source).toContain('aiOpenPositions.map((position) =>');
    expect(source).not.toContain('positions={livePositions}');
  });
});
