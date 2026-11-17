# iRexPro — Causal M5 context parity and prospective capture

**17 November 2026, 18:xx UTC | Owner Pepperstone cTrader USD DEMO | Research-only.**

## Why the early M5 candle expert currently abstains

The historical native M5 provider trend bar is frequently not persisted until *after* its five-minute close. As a result, a genuine prediction at 15 seconds into the NEXT five-minute bar may have no completed preceding native M5 candle in the PostgreSQL store. The existing prospective scorer correctly rejects such cases as \`MOST_RECENT_PRIOR_BAR_MISSING\`, rather than using the future final M5 value.

This does **not** indicate that the preceding five minutes were missing from broker quotes. The previously deployed \`irexpro-native-quote-shadow\` continuously saves positive bid/ask samples with both source and local observation timestamps, and the forming-candle collector already uses those as-of samples.

## Actual 12-hour comparison (not a model backtest)

Executed read-only using \`apps/api/scripts/run-owner-demo-m5-causal-context-parity.cjs\`. Report: \`/home/lightworld/webapps/irexpro-research/m5-context-parity/latest.json\` (private, updated only when the study runs).

| Evidence | Actual result | Meaning |
|---|---:|---|
| Completed broker-native M5 rows across four pairs | **572** | Historical reference bars, NOT as-of entry signals |
| Native M5 recorded by 15 seconds into the NEXT M5 | **34 / 572** | Native M5 availability at desired early decision is poor |
| Median native M5 record-creation delay after nominal close | **123 seconds** | Delay is not simply a missing candle |
| Native M5 delay p90 | **216 seconds** | Some delay is substantial |
| Five complete M1 bars available retrospectively | **551 / 572** | 551 reconstructed native M5 OHLC with exact retrospective parity |
| Native M1 rows proven unrevised after early cutoff | **0** | Mutable DB OHLC not certified as true as-of historical input |
| Valid as-of native positive bid/ask SAMPLE paths | **445 / 572** | 445 five-minute windows with complete source and observed quote timestamps |
| As-of sampled paths within 0.5 pip on all OHLC fields | **361 / 445** | Sampled midquotes approximate native M5, but are NOT identical |
| Sampled-quote M5 p90 maximum OHLC deviation | **0.70 pip** | Significant model-input difference for some instruments |

Sampled-quote coverage varies by instrument: EURUSD **30/143**, AUDUSD **133/143**, USDJPY **141/143**, USDCAD **141/143**. Some missing quote paths are genuine coverage/freshness failures and must not be fabricated.

A critical integrity boundary: although all 551 reconstructed M5 bars matched later native M5 OHLC exactly, every underlying current M1 set had at least one \`updated_at\` later than the hypothetical +15s cutoff. Reconstructing that historical M5 from the current mutable DB would therefore **not certify that those values were available then**. By contrast, append-only native quotes explicitly record what was observed by the cutoff. This does not make sampled quote OHLC identical to the native M5 trend OHLC.

## New deployed research collector

\`apps/api/scripts/collect-owner-demo-m5-asof-context.cjs\` runs as an isolated \`irexpro-m5-asof-context-shadow\` PM2 process. At **+15 seconds into each new five-minute period**, it reads *only* the previously recorded local native bid/ask archive for the five minutes that just ended. The captured context contains sampled midquote open/high/low/close and source timestamps; all five one-minute segments must have at least two valid observations, first quotes must not be late, and the final minute's quote must be fresh. The archive is append-only, deduplicated by period/instrument, bounded to 6MiB/day, mode 0600, retention 90 days.

Importantly, the process never queries the provider M5 database, the broker execution API, or trade state. It refuses late/backdated construction: this is **prospective evidence**, not a retrospective reconstructed "prediction." The sampled quote representation is explicitly marked \`SAMPLED_MIDQUOTE_NOT_NATIVE_M5_OHLC\`.

**No existing Plan B expert is switched to this input.** No lots, orders, risk limits, stops, profit protection or LIVE trading rules change. It is a data-collection instrument for a *separate* future model trained on exactly this quote-based input.

## Verification

- 12/12 deterministic native M1 versus sampled-as-of M5 parity tests passed.
- 9/9 prospective strict-as-of quote-context tests passed, including future-observed quote rejection, missing minute, midnight crossover, duplicate restart, private archive permissions and absence of order authority.
- GitHub Actions: \`.github/workflows/research-candle-formation-expert.yml\` checks both suites.
- Production note: Native source quote timestamps are UTC; the VPS host display timezone can differ. Use UTC for all evaluation time windows.

## Next qualification gates

1. Accumulate real prospective as-of M5-context samples over many sessions. Audit coverage across all four instruments and publish missing minute/stale quote failures, not just successes.
2. Train a new quote-context representation or causal domain adaptation model, separately from the existing native M5-trained expert, and compare the two only on compatible chronological windows.
3. Require later untouched market days, robust probability calibration, full spread + signed round-trip commissions + slippage, and account stop-risk paths before advisory promotion.
4. Evaluate the currently recorded prospective next-M5 forecasts against one-per-candle baselines; 9 separate market-time buckets from the first hour are far too few for trading claims.
5. Keep the existing M5 early stage fail-closed until the alternative representation has been independently validated. Merely matching after-the-fact native OHLC is **not sufficient**.

**Research-only recommendation:** use timestamped quote samples to improve future expert training and data availability, not to justify automatic high-lot trades or relaxed protective stops.
