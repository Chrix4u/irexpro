import { describe, expect, it } from 'vitest';
import { summarizeSpreadCostReporting } from './spread-cost-reporting';

describe('summarizeSpreadCostReporting', () => {
  it('shows one-currency measured spread with coverage and no P&L deduction semantics', () => {
    expect(
      summarizeSpreadCostReporting({
        totalTrades: 25,
        accountCurrency: 'USD',
        totalEstimatedSpreadCost: '18.75',
        spreadCostEstimatedTradeCount: 18,
        currencyBreakdown: [
          {
            accountCurrency: 'USD',
            totalEstimatedSpreadCost: '18.75',
            spreadCostEstimatedTradeCount: 18,
          },
        ],
      }),
    ).toEqual({
      hasMeasurements: true,
      hasMixedCurrencies: false,
      measuredTradeCount: 18,
      totalTradeCount: 25,
      accountCurrency: 'USD',
      totalEstimatedSpreadCost: '18.75',
      coverageLabel: '18 of 25 trades measured',
    });
  });

  it('does not combine spread money across currencies', () => {
    const result = summarizeSpreadCostReporting({
      totalTrades: 2,
      accountCurrency: null,
      totalEstimatedSpreadCost: null,
      spreadCostEstimatedTradeCount: 2,
      currencyBreakdown: [
        {
          accountCurrency: 'EUR',
          totalEstimatedSpreadCost: '2.50',
          spreadCostEstimatedTradeCount: 1,
        },
        {
          accountCurrency: 'USD',
          totalEstimatedSpreadCost: '4.00',
          spreadCostEstimatedTradeCount: 1,
        },
      ],
    });

    expect(result.hasMixedCurrencies).toBe(true);
    expect(result.totalEstimatedSpreadCost).toBeNull();
    expect(result.coverageLabel).toBe('2 of 2 trades measured');
  });

  it('describes historical ranges without quote-at-fill evidence as unmeasured', () => {
    expect(
      summarizeSpreadCostReporting({
        totalTrades: 12,
        accountCurrency: 'USD',
        totalEstimatedSpreadCost: '0',
        spreadCostEstimatedTradeCount: 0,
        currencyBreakdown: [
          {
            accountCurrency: 'USD',
            totalEstimatedSpreadCost: '0',
            spreadCostEstimatedTradeCount: 0,
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        hasMeasurements: false,
        measuredTradeCount: 0,
        coverageLabel: 'No quote-at-fill measurements yet',
      }),
    );
  });
});
