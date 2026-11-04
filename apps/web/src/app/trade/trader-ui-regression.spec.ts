import fs from 'node:fs';
import path from 'node:path';

describe('AI Trader production UI regression contract', () => {
  const tradeDir = path.resolve(__dirname);
  const pageSource = fs.readFileSync(path.join(tradeDir, 'page.tsx'), 'utf8');
  const sidebarSource = fs.readFileSync(
    path.resolve(tradeDir, '../../components/workspace-sidebar.tsx'),
    'utf8',
  );

  it('keeps the live scanning market cockpit visible in the trade surface', () => {
    expect(pageSource).toContain('SCANNING');
    expect(pageSource).toContain('Last move');
    expect(pageSource).toContain('Current AI view');
    expect(pageSource).toContain('Watched instruments');
  });

  it('keeps the enriched 24h realized-results cards and history entry point', () => {
    expect(pageSource).toContain('Realized results');
    expect(pageSource).toContain('Total loss · 24h');
    expect(pageSource).toContain('Total costs · 24h');
    expect(pageSource).toContain('authoritative24hSummary?.totalExplicitCosts');
    expect(pageSource).toContain('24h win rate');
    expect(pageSource).toContain('Trade win rate · last 20');
    expect(pageSource).toContain('Total profit · 24h');
    expect(pageSource).toContain('Actual net P&L · 24h');
    expect(pageSource).toContain('signedMoney(realised24hNetPnl, realisedCurrency)');
    expect(pageSource).toContain('Profit factor');
    expect(pageSource).toContain('View all');
  });

  it('renders recorded costs as a red debit without changing the middle win-rate card', () => {
    const costsSection = pageSource.split('<span>Total costs · 24h</span>')[1]?.split('</div>')[0];
    expect(costsSection).toContain(
      'className={Number(realised24hExplicitCosts ?? 0) > 0 ? "is-negative" : ""}',
    );
    expect(costsSection).toContain('`-${realised24hExplicitCosts}`');
    expect(costsSection).toContain('realisedCurrency');

    const middleCard = pageSource
      .split('className="ai-performance-panel__win-rate"')[1]
      ?.split('className="ai-performance-panel__money-stat"')[0];
    expect(middleCard).toContain('<span>24h win rate</span>');
    expect(middleCard).toContain('<span>Trade win rate · last 20</span>');
  });

  it('keeps reports discoverable and the history/report pages present', () => {
    expect(sidebarSource).toContain("label: 'Reports'");
    expect(fs.existsSync(path.join(tradeDir, 'history/page.tsx'))).toBe(true);
    expect(
      fs.existsSync(path.join(tradeDir, 'history/profit-protection/page.tsx')),
    ).toBe(true);
  });

  it('fetches independent AI status feeds without serially blocking the four-second refresh', () => {
    expect(pageSource).toContain('Fetch them concurrently to avoid a serial HTTP waterfall');
    expect(pageSource).toContain('await Promise.allSettled([');
    expect(pageSource).toContain('providerResult.status === "fulfilled"');
    expect(pageSource).toContain('scannerResult.status === "fulfilled"');
    expect(pageSource).toContain('tacticalResult.status === "fulfilled"');
    expect(pageSource).toContain('brokerParityResult.status === "fulfilled"');
  });

  it('binds chart polling to the effective session broker, not stale selection state', () => {
    expect(pageSource).toContain('const marketBrokerConnectionId = selectedBroker?.id ?? "";');
    expect(pageSource).not.toContain('brokerConnectionId: selectedBrokerId');
  });
});
