# z.ai Expectancy / Exit Scenario Model — 2026-11-03

Companion artifact to `ZAI_REVIEW_REPORT.md` (branch `zai/model-productivity-review-20261102`).
Purpose: a compact, reproducible decomposition of the staging closed-trade aggregate supplied in
`docs/research/zai-model-productivity-review-2026-11-02.md`, plus an analytic scenario ladder that
quantifies how much each proposed improvement class is worth **before** any code changes.
This is an analytic model, not a backtest. Every staging-dependent number below can be
re-derived with `scripts/research/zai-expectancy-decomposition.sql`.

---

## 1. Input aggregate (verbatim from the review brief)

| Quantity | Value |
|---|---|
| Closed trades with non-null realised P&L | 588 |
| Wins / Losses / Flat | 271 / 313 / 4 |
| Win rate (as reported, over 588) | 46.09% |
| Gross positive P&L | +1,420.85 |
| Gross negative P&L | −1,761.82 |
| Net P&L | −340.97 |
| Approximate profit factor | 0.81 |

## 2. Derived statistics (deterministic arithmetic)

Computed over the 584 trades with non-zero P&L (win rate over this base = 46.40%):

| Quantity | Value | Formula |
|---|---|---|
| Average win | **5.2430** | 1420.85 / 271 |
| Average loss | **5.6288** | 1761.82 / 313 |
| Realized payoff ratio | **0.9315** | 5.2430 / 5.6288 |
| Expectancy per trade | **−0.5839** | −340.97 / 584 |
| Profit factor | **0.8065** | 1420.85 / 1761.82 |
| Breakeven win rate at realized payoff | **51.77%** | 1 / (1 + 0.9315) |
| Required avg win at current WR (breakeven) | **6.5012 (+24.0%)** | 1761.82 / 271 |
| Required avg loss at current WR (breakeven) | **4.5395 (−19.4%)** | 1420.85 / 313 |

**Reading:** the system loses not because it picks wrong sides too often (46% wins is workable at the
designed payoff) but because the average win is only 0.93× the average loss while the designed
take-profit geometry is 1.6R (M1, `m1-tactical-candidate.ts:24-26`) or 1.667R
(M5, `vps-forex-signal-collector.service.ts:285-286`).

## 3. Exit-truncation factor

| Designed R:R | Realized/designed | Breakeven WR at full design | Gross E at observed WR (46.4%) |
|---|---|---|---|
| 1.600 (M1) | **0.582** | 38.46% | **+0.207R** per trade |
| 1.667 (M5) | **0.559** | 37.50% | **+0.238R** per trade |

The realized payoff is ~58% of design. The missing 42% is split between the profit-protection
retention ladder (closes at 70–90% of peak once peak ≥ 0.5R — `paper-broker.adapter.ts:728-738`),
the PAPER time-to-work stop, and transaction costs. Direction selection at the observed win rate
would be gross-profitable **if the designed payoff were realized**; this is the central finding and
the reason exit re-tuning (report proposal P1) outranks every entry-side change.

## 4. Cost-drag estimate (analytic, per-pair assumptions stated)

Cost model (system's own): `costR = 1.25 × spread / stopDistance`
(`ensemble-governance.ts:395-402`), PAPER fixed spreads from `paper-market-spec.ts:10-15`.

| Case | Spread (pips) | ATR14 (pips) | Stop mult | Stop (pips) | costR |
|---|---|---|---|---|---|
| M1 EURUSD typical | 1.0 | 6.0 | 1.1 | 6.6 | **0.189R** |
| M1 EURUSD higher-vol | 1.2 | 9.0 | 1.1 | 9.9 | **0.152R** |
| M5 EURUSD | 1.0 | 12.0 | 1.5 | 18.0 | **0.069R** |

Compare with the net-expectancy admission floor `ENSEMBLE_NET_EXPECTED_R_FLOOR = 0.08R`
(`ensemble-governance.ts:7`): a typical low-volatility M1 candidate pays ~0.19R in costs to chase a
floor of 0.08R. The M1 geometry (1.1×ATR stops with a 5-pip floor) is the structural driver — this
is report proposal P2. These are stated-assumption estimates; SQL companion §4 measures the true
distribution from staging once run against the live DB.

## 5. Scenario ladder (analytic, constant win rate)

| Scenario | Change | WR | Avg win | Avg loss | Net (units) | PF |
|---|---|---|---|---|---|---|
| S0 | baseline | 46.40% | 5.24 | 5.63 | **−341.0** | 0.806 |
| S1 | avg win restored to designed scale (+24%) — exit re-tune | 46.40% | 6.50 | 5.63 | **+0.0** | 1.000 |
| S2 | S1 + avg loss −10% (loss-side hygiene: earlier adverse-thesis cuts, meta-filter tail removal) | 46.40% | 6.50 | 5.07 | **+176.2** | 1.111 |
| S3 | S2 + meta-labeling filter removes bottom ~15% of trades at an assumed −2.0 units avg | 46.40% | 6.50 | 5.07 | **+351.4** | 1.111 (+fewer trades) |

Interpretation:

- **S1 alone reaches breakeven** — restoring the average win to the designed payoff scale, with win
  rate unchanged, erases the entire staging deficit. No admission change is required.
- **S2–S3 are upside**, contingent on the loss-side filter working out-of-sample (report §7 protocol).
- Deliberate trade-off: exit re-tuning typically *lowers* win rate by 1–4 points (fewer tiny
  protected wins) while raising the payoff; the ladder holds WR constant to be conservative.

## 6. Reproducibility

```python
wins, losses = 271, 313
gross_w, gross_l = 1420.85, 1761.82
avg_w, avg_l = gross_w / wins, gross_l / losses          # 5.2430, 5.6288
payoff = avg_w / avg_l                                    # 0.9315
pf = gross_w / gross_l                                    # 0.8065
E = (gross_w + gross_l) / (wins + losses)                 # -0.5839
be_wr = 1 / (1 + payoff)                                  # 0.5177
req_w = gross_l / wins                                    # 6.5012
req_l = gross_w / losses                                  # 4.5395
trunc = payoff / 1.6                                      # 0.582
gross_E_at_full_RR = (wins / (wins + losses)) * 1.6 - (losses / (wins + losses))  # +0.2065
```

SQL equivalents: `scripts/research/zai-expectancy-decomposition.sql` (§1–§4).
