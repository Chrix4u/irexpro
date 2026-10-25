# Friday Champion 100k Replay v1 Design

## Intent
Stress the current deployed normal-M5 Plan-B architecture across the frozen six-pair ~100k-per-pair Dukascopy corpus without training a new model, changing thresholds, or granting execution authority.

## Evidence classification
This is a **historical architecture stress replay**, not pristine holdout validation. The corpus spans roughly June–September 2026 and predates the current October runtime, but current scoring rules were developed using the project's accumulated research. Therefore the replay may falsify robustness or identify route/pair weaknesses, but success alone cannot promote PAPER, DEMO, or LIVE.

## Production parity
The replay imports production functions directly from current main:
- `buildDirectionalCandidates()` for the exact M5 candidate equations;
- `scorePlanBMultimodelShadow()` for the exact current Plan-B intrinsic scorer;
- `evaluatePaperProfitLock()` and `evaluatePaperTimeToWork()` for PAPER lifecycle exits;
- `PAPER_MARKET_SPECS` for executable spread assumptions.

No alternate indicator formulas or scorer thresholds are allowed in the replay.

## Corpus reconstruction
Each MTF CSV repeats the latest fully available M5 bar on each M1 decision row. Reconstruct the M5 stream by de-duplicating `m5_source_bar_open`, and require `m5_available_at <= decision_time`. A reconstructed bar timestamp is the M5 source-bar open time. Decisions occur only after the bar's `available_at`, matching closed-bar causality.

## Candidate evaluation
At each newly available M5 close after enough history exists:
1. Build BUY and SELL candidates from all M5 bars known at that instant using `buildDirectionalCandidates()`.
2. Score each side using `scorePlanBMultimodelShadow(candidateInput, [])` with zero portfolio positions. This isolates intrinsic architecture quality from live portfolio state.
3. Record all candidates and treat `paperAdmitted=true` as **intrinsic paper admission**, not an executed trade. Live prospective DB governance, calibration, macro-event vetoes, capital allocation, and open-position concentration are intentionally not back-filled from today's database into historical rows.
4. For trade-path stress, select at most one side per pair/bar: highest production candidate score among intrinsically paper-admitted sides. Equal-score ties fail closed (no trade).

## Execution economics
- Entry uses the PAPER executable side around the closed-candle mid: BUY at ask, SELL at bid.
- Stop/target are the candidate's production-authorized levels, computed from mid by the live candidate builder.
- Subsequent closed M5 candles are converted to executable bid/ask extremes using the same PAPER spread assumption.
- SL is checked before TP when both are touched in one bar, matching PAPER's conservative ambiguity rule.
- Profit-lock and time-to-work decisions use the exported production pure functions.
- M5 minimum forecast hold is 20 minutes.
- Profit/loss is reported in R, using initial executable entry-to-stop risk. This avoids lot-size/account-currency assumptions while preserving exact risk economics.
- If no exit occurs within 12 hours, close at the executable side of the final bar and label `TIMEBOX_12H`. This is a research timebox only and must be reported separately.

## Non-overlap
One active replay trade per instrument at a time. A new signal for that pair is ignored until the prior replay trade closes. This prevents overlapping same-pair trades from reusing the same future path and gives a conservative independent episode count. Portfolio/cross-pair overlap remains allowed because live iRexPro supports multiple instruments.

## Metrics
Report aggregate and by pair/route:
- episodes, wins/losses/breakeven;
- net R, average R, profit factor;
- R-series Sharpe using sqrt(N), clearly labeled episode Sharpe rather than annualized clock-time Sharpe;
- max drawdown in cumulative R;
- positive-instrument fraction;
- route breadth;
- same-bar SL/TP ambiguity count;
- lifecycle exit reasons;
- opportunity rate per observed trading day.

Use chronological 3-fold reporting by decision time, with whole-time boundaries. The replay never fits parameters, so folds are evaluation slices, not training folds.

## Gates
For stress diagnostics, compare the measurable gates:
- PF >= 1.15;
- episode Sharpe >= 1.0;
- max R drawdown <= 12R (reported as an R analogue, not account percentage);
- positive fold fraction >= 60%;
- positive instrument fraction >= 67%.

Balanced accuracy and mean confidence are reported separately where meaningful. Because max drawdown is in R rather than account percentage and this is not a pristine holdout, `approved_for_paper`, `approved_for_demo`, and `approved_for_live` remain false regardless of result.

## Safety
- No database reads/writes are needed.
- No live/staging process changes.
- No threshold search, model fitting, feature selection, or route tuning against replay results.
- The result may reject an architecture. A pass only justifies retaining the champion and collecting more prospective broker/PAPER evidence.
