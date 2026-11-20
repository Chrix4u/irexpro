# iRexPro — winning vs losing trades, pre-entry contradiction and a candidate abstention rule

**Owner Pepperstone cTrader USD DEMO — inspected 20 November 2026 through approximately 08:59 UTC.**

## Finding from the EXACT pre-entry record

240 broker-settled trades opened Nov17–Nov20, **131 net winners / 109 losers**. Actual broker net **-$3,079.82** (after signed commission and swap). **240/240** were matched to original, persisted-before-intent M1 tactical decisions, not reconstructed after closing.

Original Plan-B predictions show widespread positive expected R, but actual payoffs are negative after costs. Increasing a generic confidence threshold **is not reliable**. A previously frozen prospective after-fee entry discriminator from the Nov17–18 research set scored 31 new Confirmed Reversal fills on Nov20: the 14 **low-scored** signals made **+$154.25** (10 winners / 4 losers), while 17 **high-scored** trades lost **-$340.48** (7 winners / 10 losers). Its score ranking AUC was ~0.44. Applying its existing candidate low-score abstention would have **rejected more winners**, not created a demonstrated edge. Do NOT promote that scorer.

Across the joined 240-trade pre-intent decisions, the independent *trained-expert state* was `ABSTAIN` on **all 240**. This specific overlay's state is **not a win/loss discriminator** and must not be confused with the separate in-progress candlestick scanner. Blanket `expert == ABSTAIN` vetoing would suppress the whole cohort and give no discrimination.

## What the native prices show before opening

This study uses:
- Actual original trade intent, pre-entry M1 decision, and its **frozen** model M5 alignment.
- As-of Pepperstone native archived bid/ask prices, with **both source clock and archive-capture clock <= intent**; fresh last quote no older than 15 seconds, and a usable as-of 60-second earlier mid-price snapshot.
- Separate sampled in-progress M1 candle fingerprints, **last recorded before original M1 decision**, not later updated OHLC.
- ONLY broker-realized P&L as **outcome**, not a candidate input.

Both quote and candle fingerprints derive from the same broker-native feed, so they are **not independent expert model votes**. Missing evidence is `UNKNOWN`, not safe.

For **CONFIRMED_REVERSAL** (different from EARLY_TRANSITION):

| Pre-entry diagnostic | Flagged trades | Won | Lost | Actual net of flagged | Actual wins discarded if blocked |
|---|---:|---:|---:|---:|---:|
| Previous 60 sec price **>=0.3 pip against proposed trade** | 9 | 2 | 7 | **-$318.47** | 2 |
| Same quote contradiction **AND saved M5 also opposed trade** | **8** | **1** | **7** | **-$340.36** | **1** |
| In-progress sampled M1 candle body opposed direction by >=30% of candle's own sampled range | 8 | 2 | 6 | **-$116.42** | 2 |
| EITHER adverse quote OR sampled M1 candle body, with both feeds verifiably present | 17 | 4 | 13 | **-$434.89** | **4** |
| BOTH quote and forming-candle symptoms concurrently | 0 | 0 | 0 | $0 | 0 |

**The narrowly scoped candidate:** `CONFIRMED_REVERSAL` only, if fresh exact-broker pre-order 60-second price movement is adverse by at least 0.30 pips AND the original submitted model candidate's M5 alignment is negative.

Eight historical cases: **7 actual losses totaling -$357.39** vs **one actual winner +$17.03**, net **-$340.36**; mean realized risk **-0.587R**. The signal occurred over 3 dates:
- Nov17: 3 losses, no wins, -$197.32.
- Nov19: 2 losses, no wins, -$105.55.
- Nov20: 2 losses, 1 win, -$37.49.

Do **not** interpret -$340.36 as assured savings, since retrospective filtering cannot reconstruct counterfactual broker fills, allocation or future trading decisions.

## Specific reasons NOT to apply this to every strategy

Under `EARLY_TRANSITION`, the same last-60-second adverse-quote symptom was present in **23 trades, 15 wins and 8 losses**; their total actual net was -$206.03, but blindly vetoing it would **remove 15 actual winners**. `M1_FORMING_BODY_OPPOSES` in Early Transition marked 27 trades with **18 winners and nine losers**, materially the opposite relationship from Confirmed Reversal.

This is fundamentally a **strategy-specific** contrast and must not be used as an all-strategies veto, an automatic opposite-side entry, a larger-lot instruction, or proof that a model is ready for LIVE.

## Why it is not safe to activate an automated blocker yet

- The rule was **selected after inspecting Nov17–20 outcomes**. The four days are not an independent sealed holdout. Multiple related thresholds were examined, increasing false-discovery risk.
- There are only **eight** cases with both adverse 60-second movement and adverse frozen M5, with **one false positive winner**.
- The scheduler consumes completed broker M1/M5 price bars at its decision clock, whereas the additional native price-movement study uses **actual intent-time** sampled quotes. These can differ within the current minute. There is not yet an audited live hot-path measurement proven equivalent to the retrospective quote signal.
- The eight do not prove that a trade which was blocked would have retained a full loss: stop management, concurrent positions and market changes matter.
- The protected profit/stop exit imbalance remains negative even after retrospectively removing those eight: this is a **narrow improvement hypothesis**, not a system-level fix.

Accordingly, **NO execution blocker was deployed** and no existing broker-side protection, owner Start/Stop control, high-lot trial, demo lot ceiling or noon expiry was changed. Do not silently turn "shadow research" into a real no-trade veto.

## What is built and operating

`apps/api/scripts/audit-owner-demo-preentry-contradiction-cohorts.cjs` reproduces the cohort with exact original pre-intent trades, original broker quote source/capture timestamps and sampled pre-decision forming-candle observations. It includes:
- Per-strategy and per-day win/loss, actual net and normalized R.
- Explicit winners sacrificed and losers avoided under hypothetical abstention.
- Accurate UNKNOWN/missing evidence, not a fabricated all-clear.
- Stored independent research results: `/home/lightworld/webapps/irexpro-research/entry-formation/latest-preentry-contradiction-cohorts.json`, plus daily archive.
- A **fixed future scoring cohort** excluding all reviewed Nov17–20 trades. Forward-only begins **2026-11-21 00:00 UTC** and requires at least 5 distinct trading days, 30 verified qualified Confirmed Reversal fills, 10 candidate positives and 15 unflagged trades before a human review. **The report NEVER authorizes executable vetoes automatically.**
- The existing half-hourly read-only owner shadow monitor checks whether a refresh is due, performing this more expensive replay **at most every 3 hours**. No additional order service or independent timer.
- The native quote auditor supports a rolling window of up to **14 UTC days**, so later reports will drop old discovery days as they age out. The fixed frozen-rule cutoff remains 21 November and the report never treats Nov17–20 as independent validation.

Tests: `apps/api/scripts/audit-owner-demo-preentry-contradiction-cohorts.test.cjs`. They verify as-of timestamp restrictions, false-positive winner costs, strategy isolation, missing evidence, the original model M5 contrast, and that no SQL trading write/real broker veto occurs.

## Next calibration decision

Freeze the hypothesis without new tuning and observe fresh untouched trading days. A legitimate future executable DEMO-only abstention would need an independently verified **real-time** implementation matching the archived quote definition, demonstrated positive incremental after-fee economic value, high enough distinct-day coverage, false-positive winner accounting, and explicit owner control. Never auto-enable this historical rule in LIVE accounts.

The larger problem remains: **average realized losses cost about twice average wins**. Entry screening alone cannot rescue an exit-payoff policy that yields negative realized expectancy.
