# iRexPro owner Pepperstone USD DEMO — ongoing seven-lot allowance and pre-entry abstention research

**Changed 20 November 2026 after owner expressly reauthorized larger DEMO size. No LIVE authority.**

## Owner-directed demo sizing

The earlier 03:57–12:00 UTC one-day trial ended on time and is preserved in history. A **new and separate** ongoing, explicit opt-in setting is enabled on the owner's **exact** Pepperstone cTrader **USD DEMO** broker connection. It allows up to **7.00 requested lots** for already admitted continuous Confirmed Reversal and Early Transition candidates; this includes possible requests for 4, 4.5, 6 or 7 lots, not guaranteed fills. The separate historical noon artifact remains expired and can never be used for these new intents.

New helper: apps/api/src/modules/ai/owner-pepperstone-demo-ongoing-seven-lot.ts, activated by the new environment flag IREXPRO_OWNER_PEPPERSTONE_DEMO_ONGOING_7LOT_20261120=enabled (never committed as a credential or configuration value). Uses owner UUID plus separately configured exact broker connection ID, broker identity, account type DEMO, account currency USD, server clock and an explicit flag. It fails closed for any other user/account, currency or LIVE. The owner can disable the feature by changing this flag to disabled and restarting the trading API, or stop AI trading using the existing Start/Stop control.

The M1 tactical scheduler and backend position-sizing engine both use the same helper independently. Existing entry admission, model route, M5-conflict soft cap, currency exposure, risk budget at original stop, portfolio drawdown, broker max lot/step, available leverage and margin, fee/spread and fresh quote checks remain. Existing 0.75% **pre-screen** permission is not a promise that any position receives 0.75% account risk; the final capital allocation computes the actual maximum. No minimum lot of 4 or 7 is forced. Ongoing intents emit m1_owner_demo_ongoing_seven_lot_artifact rather than m1_owner_demo_noon_lot_trial_artifact.

The API was built successfully with pnpm --filter @irexpro/api build and all 15 focused Jest unit tests for ongoing authorization and historical expiry passed. The deployed VPS API restarted around **13:07 UTC**, and HTTP GET /api/v1/health returned HTTP 200 after startup. At **13:09 UTC**, one new AUDUSD Early Transition intent recorded **requested 6.00 lots, actual filled 3.44 lots**, tagged with the new ongoing artifact and NOT the expired noon artifact. The original risk limits visibly constrained the fill. Do not treat requested sizes as actual execution.

The read-only expiry integrity audit was updated to account for legitimate separately authorized **4+ and <=7** ongoing demo requests, while still flagging expired artifacts, unaccounted >4 orders and >7 requests/fills. It does not grant permission or send orders.

## Strategy-specific pre-entry abstention study

The prior broker-settled, exact-original-decision pre-entry cohort from November 17–20 contained **266 trades**, all 266 matched to original pre-intent M1 tactical decisions, with broker-native 60-second quote evidence on **223**, and in-progress M1 candle evidence on **246**. The trained expert reported ABSTAIN on all 266, so it has **zero discriminative value** in this cohort. The generic earlier pre-entry score performed poorly on later trades; do not raise that global score threshold as an execution blocker.

A frozen hypothesis already defined in the existing research is restricted to **Confirmed Reversal**: an adverse fresh native broker quote move of at least 0.30 pip during the preceding 60 seconds AND an opposing **original pre-intent model M5 alignment**. In the previously reviewed cohort, this flagged **9 broker-settled entries (7 losses, 2 wins)**. It is not error-free. Applying the same symptom to Early Transition could suppress many valid winners.

Added a **route × instrument frozen-rule breakdown** in apps/api/scripts/audit-owner-demo-preentry-contradiction-cohorts.cjs, preserving per-pair quote coverage, skipped losers, erroneously skipped winners, after-fee broker-net outcome and risk-normalized R, with separate untouched-forward scoring. It does **not** retune a threshold, train a model with future outcomes or affect a live trade. Future scoring deliberately starts **21 November 2026, 00:00 UTC**, excluding every previously inspected November 17–20 entry. The existing review criteria remain at least 5 distinct trading days, 30 qualified Confirmed Reversal fills, at least 10 warnings and 15 unflagged matched fills. Do not turn this candidate into an automatic veto until prospective incremental after-cost benefits and live quote/decision-clock parity are proven.

The economic objective is **net outcome after booked commission and swap**, normalized to verified entry stop risk where possible, not gross percentage of winning trades alone. A valid abstention model must record false positives (winning trades missed), negative controls for other routes, missing/late quote evidence, regime drift and changes in fee/slippage distribution. A hypothetical skipped historical loss is not a real broker profit.

## Trial evidence that motivated the work

The finalized noon trial returned 46/46 settled positions, net -$412.71 after $1,129.68 commissions; before commissions gross trade P&L was +$716.97. Profit protection closed 28 winners for +$2,090.91 net, but 18 other exits lost -$2,503.62 net. Investigate pre-entry loss fingerprints, broker-close execution reasons, and avoid costly losses rather than merely forcing larger lots or closing all trades early.

The ongoing seven-lot allowance is a high-size **DEMO observation**. It is not evidence of profitability, does not apply to LIVE, and is not a reason to promote models to real-money execution.

## Fresh research replay at 13:11 UTC

The read-only updated analysis reached **274 settled trades with original pre-intent decisions matched**, **228** with fresh pre-intent native 60-second broker quote evidence, and **253** with sampled M1 candle evidence. Under the frozen Confirmed Reversal-only adverse quote AND M5 opposition hypothesis, **9 of 9 historical flagged trades** comprised **7 losses, 2 winners, -$250.92 broker-net**. Their route-and-pair details: Confirmed Reversal AUDUSD 4 flagged (3 losses/1 winner, -$125.48); EURUSD 2 (1/1, -$22.13), USDCAD 1 (1/0, -$44.07), USDJPY 2 (2/0, -$59.24). On Early Transition the SAME symptom on AUDUSD flagged 6, including **4 winning trades** and 2 losing, so a global blocker would be particularly harmful. All these are exploratory observations on historically reviewed dates; the prospective untouched cohort still begins Nov21. Zero execution vetoes were deployed.
