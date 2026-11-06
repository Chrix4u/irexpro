# iRexPro cTrader DEMO — historical broker fee shadow trial
Date: November 6, 2026

The user authorized temporarily running the extra historical commission
admission floor in shadow while assessing actual closed positions after
costs, once the OOD training repair proved unable to produce an authorized
OOD model immediately.

Current OOD research has only four full quoted UTC days and zero
precise feature-complete days, so no newly trained OOD model can be
promoted now. A separate reversible DEMO fee-shadow rollout is therefore
allowed to observe actual fills for otherwise qualified PRIMARY_PLAN_B
entries. This is not the opening of any OOD-blocked signal.

The immutable policy binds AiModule to
M1_TACTICAL_ROLLOUT_POLICY_V8_PRIMARY_ONLY_FEE_SHADOW, preserving all
original limits except switching the additional p90 commission
admission veto to shadow. The old policy remains unchanged and can
be restored by rebinding a single module symbol.

The three eligible pairs, Plan-B admission, spread/slippage evidence,
pre-fee expectancy floor, OOD drift checks, risk allocation, broker
stop-loss/TP, macro-event checks, open-position protections, account
loss and portfolio limits, lot cap and active DEMO-only session mode
are untouched.

For an already-qualified primary Plan-B entry, the same previous
broker-fee gate is computed counterfactually, persisted in the SAME
M1 decision as shadowOnly=true, shadowWouldHaveBlocked, shadowReason,
shadowBrokerFeeP90R and shadowAfterFeeExpectedR. It cannot veto or
authorize any broker action.

The read-only report in scripts/research/demo_fee_shadow_trade_outcomes.sql
joins the exact model decision via trade_intent_id with broker
executions on the same user and connection. It compares after-cost
results for signals which would have been vetoed versus historically
permitted signals. It separates unfilled, open and incomplete-cost
trades from verified CLOSED, fully priced trade P&L. It does not infer
profitability from signals that never filled.

No live account or paper phase becomes eligible. This is a limited,
reversible DEMO experiment; outcomes remain uncertain and should be
reviewed by actual after-commission, after-swap net profit, loss
streaks, drawdown and reliability rather than count of orders.
