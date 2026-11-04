import fs from 'node:fs';
import path from 'node:path';

describe('closed-trade exit contribution reporting', () => {
  const pageSource = fs.readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8');
  const apiSource = fs.readFileSync(
    path.resolve(__dirname, '../../../../../api/src/modules/execution/execution-read.service.ts'),
    'utf8',
  );

  it('renders close-reason net results for the entire filtered set', () => {
    expect(pageSource).toContain('Contribution by close reason');
    expect(pageSource).toContain('summary?.reasonBreakdown?.map');
    expect(pageSource).toContain('item.totalExplicitCosts');
    expect(pageSource).toContain('item.netRealisedPnl');
    expect(pageSource).toContain('item.totalTrades - item.pnlTradeCount');
  });

  it('groups under the authenticated and filtered report, never the current page', () => {
    expect(apiSource).toContain("baseQuery.where('trade.userId = :userId'");
    expect(apiSource).toContain("baseQuery.andWhere('trade.brokerConnectionId = :brokerConnectionId'");
    expect(apiSource).toContain(".addGroupBy('trade.closeReason')");
    expect(apiSource).toContain('reasonBreakdown,');
  });
});
