# Owner-scoped DEMO trade-loss forensics (research only)

Purpose: Explain each losing Pepperstone cTrader USD DEMO Early Transition and Confirmed Reversal trade opened during 17–18 November 2026, and contrast any proposed entry-time warning against profitable fills from the same two-day cohort.

## Run and view privately on the authorized VPS

Run from `apps/api`:

```bash
node scripts/audit-owner-demo-loss-entry-forensics.cjs
node --test scripts/audit-owner-demo-loss-entry-forensics.test.cjs
```

The audit creates owner-private **0600** files under `/home/lightworld/webapps/irexpro-research/loss-entry-forensics/`:

- `latest-report.md`: a chronological, individual narrative for every net losing position, plus totals and winners-versus-losers contrasts.
- `latest-report.json`: machine-readable account-scoped loss timeline and frozen original entry evidence.
- `latest-training-cohort.json`: both winners and losers, with `entryFeatures` **separate** from `futureOutcomesDoNotUseAsInputs`.

**Do not commit or publicly serve the generated private reports.** The research code and synthetic unit tests, not the user's broker records, belong in the public repository.

## Causal safeguards

- Scope verified by matching owner user ID and authorized Pepperstone cTrader **DEMO / USD** broker connection, executed trades, and trade intents. No other accounts or LIVE orders.
- Date window is based on broker **trade open** time in UTC, which matches Ghana local time in November.
- A trade-intent route is the actual independent Early Transition / Confirmed Reversal entry authority. The primary M1 route may independently say ABSTAIN. M1 abstention or expert abstention is not proof of an invalid alternative-route execution or of a profitable opposite trade.
- Join a matching M1 decision by trade-intent ID and evaluate time no later than broker open. Features captured there include Plan-B meta-probability, consensus, trained-expert votes and admissibility, M1/M5/M15/H1/H4 directional context, body pressure, entry policy and research-only pattern memory.
- Broker net realized P&L is computed from gross settlement + **signed** commission + swap. Missing evidence is unknown, never silently treated as zero.
- A favorable unrealized peak is a sampled cTrader broker-marked **NET** P&L observation. Its comparison with final commission magnitude is only a descriptive magnitude screen, **not** another commission deduction, proof of fillability, or proof of a missed exit.
- Quote horizons +1/+3/+5/+10 minutes are labeled **POST-entry outcomes**, never available before the order. Use only completed, broker-native M1 quote-bar bid/ask marks validated by independent positive samples in the final 30 seconds; exclude marks observed after the actual trade had already closed from while-open comparisons.
- Every entry-time warning is applied to winning as well as losing fills and is explicitly labeled exploratory in-sample pattern mining.
- The 17th and 18th were **both inspected during feature discovery**, so neither is an untouched holdout. Do not train an executable flip classifier, claim a forward edge, promote LIVE, disable risk gates, modify lots, or change stops from this study.
- Use later, independent future-date, day-purged as-of broker observations and actual after-cost broker settlement to test warnings and potential early confirmation logic.

The research has **no broker order/close authority** and does not update model weights, risk settings, deployment flags, or portfolio pause consents.
