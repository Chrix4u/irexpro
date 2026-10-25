import type { LivePaperCandleInput } from '../../broker/services/live-paper-market-data.service';

export interface MtfM5Row {
  decision_time: string;
  m5_source_bar_open: string;
  m5_available_at: string;
  m5_open: string;
  m5_high: string;
  m5_low: string;
  m5_close: string;
  m5_spread_price?: string;
}

export interface ReconstructedM5Bar extends LivePaperCandleInput {
  availableAt: Date;
  spreadPrice: number | null;
}

function validDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('INVALID_M5_ROW');
  return parsed;
}

function validPrice(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('INVALID_M5_ROW');
  return parsed;
}

function normalizedBar(row: MtfM5Row): ReconstructedM5Bar {
  const decisionAt = validDate(row.decision_time);
  const timestamp = validDate(row.m5_source_bar_open);
  const availableAt = validDate(row.m5_available_at);
  if (decisionAt.getTime() < availableAt.getTime()) throw new Error('M5_BAR_NOT_YET_AVAILABLE');

  const open = validPrice(row.m5_open);
  const high = validPrice(row.m5_high);
  const low = validPrice(row.m5_low);
  const close = validPrice(row.m5_close);
  if (high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
    throw new Error('INVALID_M5_ROW');
  }
  const spreadPrice =
    row.m5_spread_price == null || row.m5_spread_price.trim() === ''
      ? null
      : Number(row.m5_spread_price);
  if (spreadPrice !== null && (!Number.isFinite(spreadPrice) || spreadPrice < 0)) {
    throw new Error('INVALID_M5_ROW');
  }

  return {
    timestamp,
    availableAt,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    spreadPrice,
  };
}

function sameBar(a: ReconstructedM5Bar, b: ReconstructedM5Bar): boolean {
  return (
    a.timestamp.getTime() === b.timestamp.getTime() &&
    a.availableAt.getTime() === b.availableAt.getTime() &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.spreadPrice === b.spreadPrice
  );
}

export function reconstructClosedM5Bars(rows: readonly MtfM5Row[]): ReconstructedM5Bar[] {
  const byOpen = new Map<number, ReconstructedM5Bar>();
  for (const row of rows) {
    const bar = normalizedBar(row);
    const key = bar.timestamp.getTime();
    const existing = byOpen.get(key);
    if (existing && !sameBar(existing, bar)) throw new Error('INCONSISTENT_M5_DUPLICATE');
    if (!existing) byOpen.set(key, bar);
  }
  return [...byOpen.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}
