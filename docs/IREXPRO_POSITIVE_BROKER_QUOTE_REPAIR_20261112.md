# iRexPro — broker-native positive bid/ask preservation and research integrity
**12 November 2026 | Staging | EURUSD + AUDUSD | RESEARCH ONLY**

## Why the initially positive AUDUSD result was withdrawn

The 60-minute AUDUSD independent Ridge + logistic challenger initially
showed +33.2 theoretical pips across 26 simulated first-touch proxy entries
on Nov 10–12. The prior M1 broker quote exporter incorrectly accepted
historical minute rows with bid_close == ask_close (zero observed spread).
A zero spread at a minute bar is *not proof of an executable quote*.

Initial mixed-source export: 30,766 M1 rows across both active pairs,
including about 5,409 zero-spread EURUSD and 2,202 zero-spread AUDUSD rows.
A stricter, account-owned, source-labeled export retained just 23,199
positive bid/ask rows. Because removing missing-spread minutes broke
many contiguous 50-bar features, 36 pair/horizon/day folds all returned
INSUFFICIENT_SEQUENTIAL_DATA. **The +33.2 pips are therefore invalid as
promotion evidence**. There is no qualified new alpha.

## Data-capture defect measured

The quote collector runs a live loop but records the *last broker quote*
for each M1 bucket in bid_close/ask_close. If the last provider tick has
bid == ask, bid_close == ask_close, even when earlier ticks within the
same minute had genuine positive spread. In a read-only four-hour audit:
- EURUSD 240 minutes: 188 zero-spread closes, of which 184 had earlier
  independently recorded positive quote samples.
- AUDUSD 240 minutes: 61 zero-spread closes, all 61 had positive
  samples earlier in those same minutes.

The earlier positive sample counter did NOT retain the earlier tick's
actual bid/ask, so those historical prices **cannot be reconstructed**
from available records. Do not replace them with current spreads.

## Implemented and deployed

1. New additive migration:
   `1794528000000-AddLastPositiveBrokerMinuteQuote.ts`. Adds four
   separately named numeric/timestamp columns to the existing
   `market_data.provider_quote_candles` table; they start NULL, with
   no fabricated historical backfill.
2. The live quote store writes only **observed positive bid/ask prices**
   and their exact sample time into those columns; a later zero-spread
   tick does not erase them. Original bid_close/ask_close, zero quotes,
   and sample counters keep their existing semantics.
3. The internal Python broker M1 feature reader uses the independently
   observed last-positive spread for the historical candle when available.
   It does not invent unknown spread information. Most recent M1 uses
   existing conservative current/P90 execution spread evidence.
4. Read-only net-alpha exporter now verifies the broker owner,
   partitions archived older cTrader pretraining before each current
   pair's first Pepperstone mark, rejects zero spreads and exports
   the actual last-positive minute tick separately when present,
   with source/provenance fields.
5. Daily audit remains strictly research-only. Its validator requires
   owner-verified broker quote source, positive bid/ask evidence,
   NOT_QUALIFIED_FOR_DEMO_EXECUTION, no auto-promotion and zero broker orders.
   Root-owned schedule: 21:25 UTC weekdays, low priority, single flight.
6. Python v8.5 broker scoring now differentiates historic unobservable
   spread from genuinely transient scoring errors. No positive price is
   fabricated. Bounded transient retries stop after three attempts.

### Verification

- The additive migration applied and was registered in
  `public.migrations`; existing table rows were not rewritten.
- First post-deployment new M1 quote sample records populated
  `last_positive_bid/ask/spread/sample_at` on Pepperstone. An
  EURUSD zero-close minute retained the earlier positive tick.
- 76 focused API Jest tests passed and NestJS production build passed.
- Python challenger and historical-broker-spread tests passed.
- PM2 staging API, AI engine and web are online.
- AI Trading still has **no newly authorized broker entries** during
  this investigation. No risk gates, demo positions, live account flags
  or stop-loss placement policies were relaxed.

## What remains before DEMO pilot

- Accumulate independently observed positive broker bid/ask marks
  consistently over forward UTC sessions. Verify both tick coverage
  and completed M1 price-feature continuity.
- Re-run independent BUY/SELL forecasts with train/holdout purge,
  after-cost bid/ask marks and realistic stop-first barriers. Report
  partial-day status and cross-broker training shifts.
- Require sufficient separate **completed** Pepperstone holdout dates
  and prospectively frozen signals; no holdout-based cherry-picking
  among twelve pair/horizon combinations.
- Account-level risk, margin and drawdown replay with actual Pepperstone
  DEMO fills. Explicit manual DEMO approval only after independent
  evidence; no LIVE promotion without separate user authorization.
