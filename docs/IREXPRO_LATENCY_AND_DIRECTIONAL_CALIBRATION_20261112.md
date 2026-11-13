# iRexPro — 12 November 2026 follow-up, after 14:08 UTC

## AI Trader latency correction: installed in web staging

The original `/trade` initial read was serialized on four nonessential
AI research endpoints, an automation-runtime read, financial/execution reads,
and an optional `/trading/sessions/latest-ended` history read. A slow
non-authoritative endpoint could leave the financial cards on dashes long
after the page rendered.

Changes in `apps/web/src/app/trade/page.tsx` and
`apps/web/src/lib/trader-terminal-status.ts`:
- Broker/risk/active-session remain the authoritative fail-closed controls.
- `/trading/sessions/latest-ended` is fetched asynchronously, with a
  60-second throttle, and is never waited on before showing the account.
  User- and broker-context checks prevent older responses overwriting newer
  session data. Existing broker-side risk gates are untouched.
- Non-authoritative provider performance, VPS scanner, M1 status,
  broker-parity and v8 status are loaded concurrently **in a separate
  bounded single-flight polling path**. A temporarily failing research
  endpoint retains the most recent verified screen state.
- Automation runtime status is likewise asynchronous and independently
  rate-limited; account balances, allocation, execution and open
  positions load while research continues.
- Route-level + client-level skeleton from commit 9d406de2 remains in place,
  with partial KPI loading states rather than fake balance zeros.

Validation: TypeScript check passed; three focused frontend test suites
including a unit test proving that a permanently pending latest-ended
history call cannot block the terminal; 12 tests passed. Web production
Next.js build passed, PM2 reloaded, /trade HTTP 200 on localhost (~1.3s
server request). This is NOT an authenticated measured end-to-end browser
paint or a guarantee on every connection. No trading authority changes.

## Read-only directional performance audit

Script: `apps/api/scripts/audit-m1-directional-price-moves.cjs`
Command (on the authorized staging VPS):
```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node scripts/audit-m1-directional-price-moves.cjs
```
Output: root-only mode-0600 JSON in /tmp. This performs SELECTs only;
no order submissions, database writes, promotions, model changes or
risk-control changes.

- Sampled 12,399 broker-bound M1 directional rows, about three days
  of Pepperstone DEMO history.
- 960 first-signal/15m pair+direction buckets for **ALL** directional
  hypotheses (including ABSTAIN), 467 for non-ABSTAIN M1 routes and
  100 for Plan-B-admitted, non-ABSTAIN M1 routes.
- Entry at the minute after each historical evaluation, later bid/ask
  exit mark at 1,3,5,10,30,60m. Broker spread is included, with extra
  estimated 0.9pip round-trip commission and 0.2pip slippage.
- Limit overlapping marks per pair/side/horizon, use the first signal in
  each predefined 15m slot, never best later movement.
- No stop-loss/take-profit first touch, live fills, slippage tails, or
  account-level concurrent position arbitration. These are quote-mark
  research observations **not actual broker P&L**.
- Hindsight best-direction moves are expressly a nontradable ORACLE.
  They demonstrate that price moved, not that the model could foresee it.

### Selected results (10-minute theoretical after-cost mark)
- All directional **hypotheses including ABSTAIN**:
  EURUSD 440 marks, -559.0 pips; AUDUSD 474 marks, -615.4 pips.
  Not valid to call these broker-authorized direction choices.
- Only non-ABSTAIN, M1-routed candidates:
  EURUSD 178 marks, -239.1 pips; AUDUSD 216 marks, -237.7 pips.
- Only Plan-B-paper-admitted AND non-ABSTAIN candidates:
  EURUSD 39 marks, -54.6 pips; AUDUSD 52 marks, -45.2 pips.

### 60-minute longer-horizon follow-up
- Plan-B-paper-admitted routed EURUSD: 23 marks, +35.5 pips; by
  UTC day +29.8, +26.2, then -20.5. Too small / not day-stable for DEMO.
- Plan-B-paper-admitted routed AUDUSD: 30 marks, -17.0 pips; three
  days +3.8, -9.4, -11.4.

## Consequence for strategy design

Changing the trade veto count cannot create profit when directional
hypotheses are negative after estimated costs. Priority is an independent
forecast with calibrated signed expected net move/uncertainty/expected
adverse excursion and a TP/SL/timeout policy; compare only on fully
forward, later broker quote data, then allow **explicit controlled DEMO**
pilot after robust post-cost success. Keep margin, kill switch, broker
stop, portfolio drawdown and account-risk safeguards. Do not promote
to LIVE automatically.

### Source-of-truth status at first follow-up
At 14:08 UTC there were 38 M1 decisions per active pair during the
prior 20min and zero entry approvals; last DEMO trade opened 10:09 UTC
and another trade closed 10:19 UTC. Research shadow v8.5 began reporting
READY checkpoints after broker-source repair; intermittent scoring
errors still require review.
