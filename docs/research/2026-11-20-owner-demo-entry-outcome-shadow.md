# iRexPro — route-specific DEMO pre-entry win/loss discriminator

*Built November 20, 2026, UTC/Ghana time.* Research-only.
This work **does not change** Start/Stop, model-admission gates, broker
risk, trade sizing, SL/TP, margins, or LIVE permissions.

## Architecture delivered

A reproducible after-fee trainer and a deterministic, low-cost
per-candidate prediction sidecar.

1. Historical training joins every settled USD DEMO broker fill to the
   exact `m1_decision_id`, requiring the decision to be created BEFORE
   trade intent and broker order. Post-entry prices, closing reason and
   P&L never become input features.
2. Training is frozen on November **17–18 only** (closed before
   2026-11-19 00:00 UTC). The model is evaluated on the separate
   November 19 trading day without refitting coefficients or cutoff.
3. Seven feature inputs are frozen at entry:
   direction-aligned M5 trend, latest aligned completed M5 candle body,
   H1 and H4 alignment, aligned M1 three-bar momentum, Plan B ensemble
   score and Plan B forecast *after-spread* R. Trained expert signals,
   signed M1 candle body/wicks and quote provenance are recorded in
   the existing decision ledger as separate research evidence, without
   falsely labeling them as a fitted expert model.
4. Models are independent by Plan B strategy and use regularized
   logistic regression; no overall mixed-strategy veto.
5. The lowest-score quartile threshold is determined from each route's
   **training observations only**. Persisted model output includes
   probability estimates and `researchLowScoreFlag`. These fields are
   not referenced by execution, position sizing or order dispatch.
6. Owner and exact active broker connection ID must match the existing
   private VPS scanner configuration, and the snapshot must be
   completed, broker-native and pre-entry. All other accounts receive
   no shadow score. No new account permissions.
7. Scores and as-of candle data are saved to
   `trading.m1_tactical_decisions.governance` under
   `ownerDemoEntryOutcomeShadow` and
   `ownerDemoPreEntryCandleSnapshot`.
8. A prospective, read-only scoreboard only counts *actual future
   settled* broker trades with a frozen score saved BEFORE their intent.
   It separates skipped losing trades from sacrificed winning trades,
   reports after-fee USD and USD per lot, and never claims non-executed
   price movements are broker profits.

## Fitted training and later-day results

191 total historic USD DEMO fills: 104 winners, 87 losers, net
**−$2,213.53** after recorded commission/swap.

| Route | Training n | Nov 19 n | Nov 19 win-ranking AUC | Frozen lowest quartile on Nov 19 |
|---|---:|---:|---:|---|
| Confirmed Reversal | 53 (29W/24L) | 65 (27W/38L) | **0.5721** | 17 flagged; 12 losses and **5 wins**; historically would avoid −$595.33 |
| Early Transition | 45 (25W/20L) | 16 (14W/2L) | **0.3929** | 1 winning trade flagged, 0 losses; historically worsens −$34.40 |
| Trend Continuation | 1 (1W/0L) | 11 (8W/3L) | **N/A** | Not fitted: insufficient training |

All scores are **conditional on already executed trades**. Small
correlated currency trades, owner-specific conditions and the previously
inspected Nov19 evaluation date make these results exploratory. The
`researchLowScoreFlag` is NOT a recommended blocker. AUC 0.572
has modest ranking value; neither model establishes live profitability.
Do not promote the Early Transition fit on these results.

## Actual prospective evaluation

From 2026-11-20 00:00 UTC onward, an owner USD DEMO trade can be
qualified for the prospective report only when the score was persisted
before its intent and verified against the unchanged original route.
The scoreboard intentionally excludes training-period outcomes,
never uses backfilled or updated decision features, and reports any
unavailable/mismatched records separately.

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node scripts/audit-owner-demo-entry-discriminator-prospective.cjs
```

Private report:
`/home/lightworld/webapps/irexpro-research/entry-formation/prospective-after-fee-scoreboard.json`

Train and rerun (research only, not an automatic trading-policy action):

```bash
node scripts/train-owner-demo-entry-outcome-shadow.cjs
node --test scripts/train-owner-demo-entry-outcome-shadow.test.cjs scripts/audit-owner-demo-entry-discriminator-prospective.test.cjs
pnpm exec jest src/modules/ai/owner-demo-entry-outcome-shadow.spec.ts --runInBand
```

The frozen model source is
`src/modules/ai/owner-demo-entry-outcome-model.generated.ts`.
Its version and training cutoff are persisted per-scored decision.

## Qualification philosophy

Report real future instrument, route and trading-day groups separately.
A candidate hard avoidance rule should demonstrate a sustained increase
in **after-fee net expectancy and capital efficiency** over later
untouched market sessions, without discarding disproportionate winners.
Also compare execution-independent 15-minute native quote outcomes for
unfilled candidates to surface selection bias; those are never broker
profits. Refit cautiously on newly resolved data only after the prior
model's prospective results are recorded. No shadow observation can
authorize a LIVE broker order.
