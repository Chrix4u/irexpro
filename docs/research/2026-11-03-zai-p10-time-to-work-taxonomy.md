# z.ai proposal P10 — preserve PAPER TIME_TO_WORK exit provenance

This increment is **reporting/attribution only**. It does not alter broker
orders, mandatory stop/target, DEMO or LIVE admission, position sizing,
the PAPER time-to-work exit policy, or existing trade rows.

## Existing error
The paper-broker adapter correctly reports its explicit
`closeReason: 'TIME_TO_WORK'`, but reconciliation was coalescing it into
`TradeCloseReason.AI_CLOSE_SIGNAL`. This conflated a time-to-work forced
exit with a discretionary AI direction flip, distorting exit autopsies.

## Fix
- Add `TradeCloseReason.TIME_TO_WORK` and map explicit provider observations
  to it while preserving the existing provider-specific provenance rule.
- Add the new value to the frontend-safe execution union, trade-history reason
  filter and read-only validators.
- Assert close reason and provider provenance in the reconciliation tests.
- Preserve historical rows; do not infer which old `AI_CLOSE_SIGNAL` exits
  were actually time-to-work without verified original broker events.

## Database compatibility
The connected staging database currently has
`trading.trades.close_reason varchar(50)` with **no close-reason CHECK** and
no corresponding PostgreSQL enum type. The additional literal therefore
requires no stage DDL migration; the application's TypeScript enum remains a
typed API boundary and the existing migrated DB column accepts the new value.
Inspect other deployed customer schemas before shipping this behavior
beyond the staging environment.

## Safety
Only PAPER broker close observations use this provider reason currently.
This change is not a claimed strategy improvement. It only increases the
accuracy of subsequent route-specific profitability and exit studies.
