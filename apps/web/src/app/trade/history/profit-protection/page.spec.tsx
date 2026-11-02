import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/context/auth-context', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, logout: jest.fn(), restoring: false }),
}));

jest.mock('@/components/ui', () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  LoadingSpinner: () => <div>Loading…</div>,
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/lib/profit-protection-exit-quality', () => ({
  loadProfitProtectionExitQuality: jest.fn(),
}));

import { loadProfitProtectionExitQuality } from '@/lib/profit-protection-exit-quality';
import ProfitProtectionExitQualityPage from './page';

const loadReport = loadProfitProtectionExitQuality as jest.MockedFunction<
  typeof loadProfitProtectionExitQuality
>;

const REPORT = {
  page: 1,
  pageSize: 25,
  total: 2,
  totalPages: 1,
  summary: {
    total: 2,
    resolvedCount: 2,
    tpFirstCount: 1,
    slFirstCount: 1,
    tpFirstRate: 0.5,
    slFirstRate: 0.5,
    ambiguousCount: 0,
    neitherCount: 0,
    dataGapCount: 0,
    smallProfitCount: 1,
    smallProfitTpFirstCount: 1,
    smallProfitTpFirstRate: 1,
    accountCurrency: 'EUR',
    actualRealisedPnl: '8.25',
    averageActualExitR: 0.3,
    averageCounterfactualR: 0.25,
    averageRDelta: -0.05,
    currencyBreakdown: [
      { accountCurrency: 'EUR', tradeCount: 2, actualRealisedPnl: '8.25' },
    ],
  },
  routes: [
    {
      strategyRoute: 'CONFIRMED_REVERSAL' as const,
      total: 2,
      tpFirstCount: 1,
      slFirstCount: 1,
      tpFirstRate: 0.5,
    },
  ],
  items: [
    {
      tradeId: 'trade-1',
      brokerConnectionId: 'broker-1',
      instrument: 'EURUSD',
      direction: 'SELL' as const,
      strategyRoute: 'CONFIRMED_REVERSAL' as const,
      outcome: 'TP_FIRST' as const,
      accountCurrency: 'EUR',
      realisedPnl: '3.25',
      actualExitR: 0.25,
      originalTargetR: 1.5,
      counterfactualR: 1.5,
      rDelta: 1.25,
      minutesAfterClose: 17.5,
      closedAt: '2026-10-30T10:00:00.000Z',
      eventAt: '2026-10-30T10:17:30.000Z',
    },
  ],
};

describe('ProfitProtectionExitQualityPage', () => {
  beforeEach(() => {
    loadReport.mockReset();
    loadReport.mockResolvedValue(REPORT);
  });

  it('shows exit-quality cards, research warning, route evidence and trade-level counterfactual detail', async () => {
    render(<ProfitProtectionExitQualityPage />);

    expect(await screen.findByRole('heading', { name: 'Profit Protection Exit Quality' })).toBeInTheDocument();
    expect(await screen.findByText('2 evaluated')).toBeInTheDocument();
    expect(screen.getAllByText('50.0%')).toHaveLength(2);
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
    expect(screen.getByText('-0.05R')).toBeInTheDocument();
    expect(screen.getByText(/research evidence, not realised returns/i)).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed Reversal').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('EURUSD').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('TP first').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('+1.25R')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /closed trade history/i })).toHaveAttribute('href', '/trade/history');
  });

  it('applies the small-profit filter through the server adapter instead of recomputing rows locally', async () => {
    render(<ProfitProtectionExitQualityPage />);
    await waitFor(() => {
      expect(loadReport).toHaveBeenCalledWith(expect.objectContaining({
        smallProfitOnly: false,
        page: 1,
      }));
    });

    fireEvent.click(screen.getByRole('checkbox', { name: /small profits only/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));

    await waitFor(() => {
      expect(loadReport).toHaveBeenLastCalledWith(expect.objectContaining({
        smallProfitOnly: true,
        page: 1,
      }));
    });
  });
});
