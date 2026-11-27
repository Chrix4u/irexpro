import fs from 'node:fs';
import path from 'node:path';

describe('closed history settlement presentation contract', () => {
  const source = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');

  it('marks unsettled close time and duration as unverified', () => {
    expect(source).toContain("if (hasPendingClosedTradeSettlement(trade)) return 'Unverified';");
    expect(source).toContain('Settlement pending — time unverified');
    expect(source).toContain('<th>Recorded close</th>');
    expect(source).toContain('<th>Recorded close reason</th>');
    expect(source).toContain('Average recorded hold');
  });

  it('distinguishes recorded gross row P&L from aggregate net results', () => {
    expect(source).toContain('<th>Gross realized P&amp;L</th>');
    expect(source).toContain('summary?.netRealisedPnl');
    expect(source).toContain('Known net P&L');
  });
});
