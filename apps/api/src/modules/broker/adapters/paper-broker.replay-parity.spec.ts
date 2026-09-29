import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PaperBrokerAdapter } from './paper-broker.adapter';

describe('PaperBrokerAdapter replay parity', () => {
  const originalReplay = process.env.PAPER_REPLAY_M1_CSV;
  const originalStart = process.env.PAPER_REPLAY_START;
  let dir = '';

  afterEach(() => {
    if (originalReplay === undefined) delete process.env.PAPER_REPLAY_M1_CSV;
    else process.env.PAPER_REPLAY_M1_CSV = originalReplay;
    if (originalStart === undefined) delete process.env.PAPER_REPLAY_START;
    else process.env.PAPER_REPLAY_START = originalStart;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('drops incomplete higher-timeframe replay buckets like the research corpus builder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'irexpro-paper-replay-'));
    const csv = join(dir, 'USDJPY_M1.csv');
    const start = Date.parse('2026-09-27T16:00:00.000Z');
    const rows = [
      'timestamp,open,high,low,close,volume,tick_volume,spread_points,price_digits',
    ];
    for (let minute = 0; minute <= 301; minute += 1) {
      const ts = new Date(start + minute * 60_000).toISOString();
      rows.push(`${ts},150.000,150.010,149.990,150.000,10,10,12,3`);
    }
    writeFileSync(csv, rows.join('\n') + '\n');

    process.env.PAPER_REPLAY_M1_CSV = csv;
    process.env.PAPER_REPLAY_START = '2026-09-27T21:01:00.000Z';

    const adapter = new PaperBrokerAdapter();
    await adapter.connect({ accountId: 'paper-account-001' });

    const pureQuoteA = await adapter.getCurrentPrice('USDJPY');
    const pureQuoteB = await adapter.getCurrentPrice('USDJPY');
    expect(pureQuoteA.timestamp.toISOString()).toBe('2026-09-27T21:00:00.000Z');
    expect(pureQuoteB.timestamp.toISOString()).toBe('2026-09-27T21:00:00.000Z');

    const advancedQuote = await adapter.getCurrentPrice('USDJPY', { advanceSimulation: true });
    expect(advancedQuote.timestamp.toISOString()).toBe('2026-09-27T21:01:00.000Z');

    const h4 = await adapter.getOHLCV('USDJPY', 'H4', 10);
    expect(h4).toHaveLength(1);
    expect(h4[0]!.timestamp.toISOString()).toBe('2026-09-27T16:00:00.000Z');

    const m5 = await adapter.getOHLCV('USDJPY', 'M5', 100);
    expect(m5).toHaveLength(60);
    expect(m5.at(-1)!.timestamp.toISOString()).toBe('2026-09-27T20:55:00.000Z');

    await expect(
      adapter.getRequiredMargin({ instrument: 'USDJPY', lotSize: '0.10', direction: 'BUY' }),
    ).resolves.toBe('100.00');
  });
});
