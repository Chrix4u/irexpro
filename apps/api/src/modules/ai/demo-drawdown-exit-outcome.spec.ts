import {
  assessDemoDrawdownAfterExit,
  type AfterExitQuoteBar,
  type AfterExitTrade,
} from './demo-drawdown-exit-outcome';

const close = new Date('2026-11-10T10:00:10Z');
const observed = new Date('2026-11-10T11:02:00Z');
const buy: AfterExitTrade = {
  instrument: 'EURUSD',
  direction: 'BUY',
  closedAt: close,
  stopLoss: 1.099,
  takeProfit: 1.102,
};
const sell: AfterExitTrade = {
  instrument: 'EURUSD',
  direction: 'SELL',
  closedAt: close,
  stopLoss: 1.101,
  takeProfit: 1.098,
};
function sample(i: number, bid = 1.1, ask = 1.10002): AfterExitQuoteBar {
  const started = new Date(Date.parse('2026-11-10T10:01:00Z') + i * 60_000);
  return {
    bucket_time: started,
    source: 'ctrader-broker-native',
    bid_close: bid,
    ask_close: ask,
    sample_count: 24,
    positive_quote_sample_count: 24,
    last_quote_sample_at: new Date(started.getTime() + 50_000),
  };
}
const sixtyMinutes = () => Array.from({ length: 59 }, (_, i) => sample(i));

describe('broker-native post drawdown-guard quote-close audit', () => {
  it('recognizes observed original SL after a protective early BUY exit', () => {
    const bars = sixtyMinutes();
    bars[3] = sample(3, 1.0988, 1.09882);
    const r = assessDemoDrawdownAfterExit(buy, bars, observed);
    expect(r.classification).toBe('ORIGINAL_SL_CROSSED_FIRST');
    expect(r.firstStopQuoteCloseAt).toBe('2026-11-10T10:05:00.000Z');
    expect(r.firstTakeProfitQuoteCloseAt).toBeNull();
    expect(r.quoteCoverage).toBe(100);
    expect(r.executionAuthority).toBe('NONE');
    expect(r.modifiesExecution).toBe(false);
  });

  it('recognizes observed original TP and does not label it an SL win', () => {
    const bars = sixtyMinutes();
    bars[2] = sample(2, 1.1022, 1.10222);
    bars[8] = sample(8, 1.0988, 1.09882);
    const r = assessDemoDrawdownAfterExit(buy, bars, observed);
    expect(r.classification).toBe('ORIGINAL_TP_CROSSED_FIRST');
    expect(r.firstTakeProfitQuoteCloseAt).toBe('2026-11-10T10:04:00.000Z');
    expect(r.firstStopQuoteCloseAt).toBe('2026-11-10T10:10:00.000Z');
  });

  it('uses ASK for a short trade, not its BID', () => {
    const bars = sixtyMinutes();
    bars[1] = sample(1, 1.098, 1.09807);
    bars[3] = sample(3, 1.0978, 1.0979);
    const r = assessDemoDrawdownAfterExit(sell, bars, observed);
    expect(r.classification).toBe('ORIGINAL_TP_CROSSED_FIRST');
    expect(r.firstTakeProfitQuoteCloseAt).toBe('2026-11-10T10:05:00.000Z');
  });

  it('refuses to infer an earliest barrier if a quote is missing before the crossing', () => {
    const bars = sixtyMinutes();
    bars.splice(1, 1);
    bars[2] = sample(3, 1.0986, 1.09862);
    const r = assessDemoDrawdownAfterExit(buy, bars, observed);
    expect(r.classification).toBe('INSUFFICIENT_QUOTE_COVERAGE');
    expect(r.firstStopQuoteCloseAt).not.toBeNull();
  });

  it('refuses to treat synthetic prices or zero independently quoted samples as evidence', () => {
    const bars = sixtyMinutes();
    bars[5] = { ...sample(5, 1.0989, 1.09892), source: 'generated' };
    bars[8] = { ...sample(8, 1.0989, 1.09892), positive_quote_sample_count: 0 };
    const r = assessDemoDrawdownAfterExit(buy, bars, observed);
    expect(r.classification).toBe('INSUFFICIENT_QUOTE_COVERAGE');
    expect(r.validQuoteBars).toBe(57);
    expect(r.firstStopQuoteCloseAt).toBeNull();
  });

  it('does not use quotes from the partial exit minute as if they were after exit', () => {
    const bars = sixtyMinutes();
    bars.push({
      ...sample(-1, 1.098, 1.09802),
      bucket_time: new Date('2026-11-10T10:00:00Z'),
    });
    const r = assessDemoDrawdownAfterExit(buy, bars, observed);
    expect(r.classification).toBe('NEITHER_CROSSED_IN_FULL_WINDOW');
  });

  it('requires a fully elapsed 60-minute horizon before classifying a position', () => {
    const bars = sixtyMinutes();
    bars[2] = sample(2, 1.098, 1.09802);
    const r = assessDemoDrawdownAfterExit(buy, bars, new Date('2026-11-10T10:59:59Z'));
    expect(r.classification).toBe('AWAITING_FULL_HORIZON');
    expect(r.firstStopQuoteCloseAt).toBeNull();
  });

  it('never infers a clean non-event from missing bars', () => {
    const r = assessDemoDrawdownAfterExit(buy, sixtyMinutes().slice(0, 40), observed);
    expect(r.classification).toBe('INSUFFICIENT_QUOTE_COVERAGE');
  });

  it('rejects inverted or missing stop/TP instead of assuming a successful exit', () => {
    for (const trade of [
      { ...buy, stopLoss: 1.103 },
      { ...buy, takeProfit: Number.NaN },
      { ...sell, stopLoss: 1.097 },
    ]) {
      expect(assessDemoDrawdownAfterExit(trade, sixtyMinutes(), observed).classification).toBe(
        'INVALID_TRADE',
      );
    }
  });
});
