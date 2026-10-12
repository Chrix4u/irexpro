/** Shared executable quote assumptions for the six-pair PAPER broker. */
export interface PaperInstrumentSpec {
  digits: number;
  spread: number;
  description: string;
}

export const PAPER_MARKET_SPECS: Readonly<Record<string, Readonly<PaperInstrumentSpec>>> =
  Object.freeze({
    EURUSD: { digits: 5, spread: 0.0001, description: 'Euro vs US Dollar' },
    GBPUSD: { digits: 5, spread: 0.00012, description: 'British Pound vs US Dollar' },
    USDJPY: { digits: 3, spread: 0.01, description: 'US Dollar vs Japanese Yen' },
    AUDUSD: { digits: 5, spread: 0.0001, description: 'Australian Dollar vs US Dollar' },
    USDCAD: { digits: 5, spread: 0.00012, description: 'US Dollar vs Canadian Dollar' },
    USDCHF: { digits: 5, spread: 0.00012, description: 'US Dollar vs Swiss Franc' },
  });
