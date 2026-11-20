# iRexPro: November 17 Pepperstone DEMO profit-lock hold-vs-close audit

## Verified account trial

The owner's Pepperstone cTrader **USD DEMO** one-shot advisory reversal/early-transition pilot has filled its original **4/4** broker-intent budget as of 01:52 UTC, November 17, 2026. A new trial must not silently reset, reinterpret or override that cap.

Actual executed pilot trades, with realised P&L plus signed commission and swap:
- USDJPY BUY, EARLY_TRANSITION, 00:44 UTC: **−$120.81 net**, broker close after a +$72.20 recorded favorable peak, before the new alternate-route profit-lock deployment
- AUDUSD BUY, CONFIRMED_REVERSAL, 01:02 UTC: **+$4.53 net**, PROFIT_PROTECTION
- AUDUSD BUY, CONFIRMED_REVERSAL, 01:36 UTC: **+$27.52 net**, PROFIT_PROTECTION
- USDJPY SELL, CONFIRMED_REVERSAL, 01:41 UTC: **+$30.86 net**, PROFIT_PROTECTION

**Four-trade combined net −$57.90.** Three profitable protected closes do not erase one large early-transition loss or qualify LIVE promotion.

## Causal close-decision audit and subsequent observational study

At 01:46:55 UTC, the AUDUSD BUY profit lock created an `audit.audit_logs` `DEMO_PROFIT_LOCK_TREND_RECHECK` marked **CLOSE_CANDIDATE**, reason `THESIS_NOT_EXECUTABLE`, with three live M1 bars. At 01:47:55 UTC, the USDJPY SELL likewise recorded **CLOSE_CANDIDATE / THESIS_NOT_EXECUTABLE**. The TP-runner canary incorrectly recorded `NOT_CTRADER_DEMO` for Pepperstone because its preflight accepted only `ctrader`. This was a *shadow metadata* mismatch; it did **not** weaken or disable the actual broker profit lock.

The newly added read-only script `apps/api/scripts/audit-pepperstone-profit-lock-postexit.cjs` independently reads **completed broker M1 bid/ask CLOSING marks** for the 3, 5, 10 and 15 minutes *after* owner-scoped, DEMO-only profit-protected trades; no future price is ever fed to the live executor. Snapshot at 01:55 UTC:
- 3 closed Confirmed Reversal profit-protection trades studied
- 8 matured post-exit windows (3/5/10/15-minute ranges, depending on trade age)
- **0 windows** with an M1 bid/ask **closing mark** reaching the original TP
- After the 01:07 AUDUSD profit close, the best further sampled bid-close move was **+0.3 pip** through 15 minutes, with worst **−4.2 pips**
- After the 01:46 AUDUSD profit close, the best further sampled bid-close move was **+0.2 pip** through 5 minutes, with worst **−1.1 pips**
- After the 01:47 USDJPY SELL profit close, the best further sampled ask-close move was **0.0 pip** through 5 minutes, with worst **−2.0 pips**

Crucial limitations: a sampled M1 close **cannot prove an intrabar TP was never touched**. Hypothetical delayed orders would incur market execution uncertainty, changing exposure and potentially forfeiting protected profits. This small sample does not prove predictive quality. No new longer-hold or partial-close policy is executable on this evidence.

## Research attribution correction

The `zai-p1-reversal-demo-canary.ts` and `zai-p1-partial-leg-proof.ts` pure read-only preflights now recognize **all exact registered cTrader family broker IDs** (including `pepperstone-ctrader` and `icmarkets-ctrader`) only when account type is **DEMO**. The independent trend approval and financial economics gates remain. Both explicitly return `canSendPartialClose=false`, `canModifyOrder=false`, and/or `canDispatchOrder=false`. Actual positions, profit-lock execution, account permissions, risk, lot sizing, all existing trial timeboxes and LIVE are **untouched**.

### Commands

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/audit-pepperstone-profit-lock-postexit.test.cjs
node scripts/audit-pepperstone-profit-lock-postexit.cjs
pnpm exec jest --runInBand --no-coverage --runTestsByPath src/modules/execution/reconciliation/zai-p1-reversal-demo-canary.spec.ts src/modules/execution/reconciliation/zai-p1-partial-leg-proof.spec.ts
```

The postexit report is written atomically with 0600 permissions at `/home/lightworld/webapps/irexpro-research/profit-lock-postexit/latest-report.json`; no personal account IDs are shared and the report is never ingested into trade authority.
