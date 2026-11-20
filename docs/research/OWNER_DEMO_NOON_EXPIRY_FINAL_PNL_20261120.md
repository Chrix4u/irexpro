# iRexPro owner Pepperstone USD DEMO: noon expiry and final trial economics

## Verified on 20 November 2026, 12:14 UTC (Ghana)

The owner-authorized, time-limited demo trial began at 03:57 UTC and expired at **12:00:00 UTC**. This was NOT a LIVE trading authorization. Results are scoped to the exact owner and Pepperstone cTrader USD DEMO broker connection, with source trial-intent metadata.

**46 actual broker fills, 46 settled, zero open, 28 after-fee wins, 18 after-fee losses, net -$412.71.** Broker-recorded gross trade P&L before commissions was +$716.97, signed commissions were -$1,129.68, swap $0.00. Summed broker-net winners = +$2,090.91; losing trades = -$2,503.62. Profit factor = 0.8352 and win rate = 60.87%. Average winning trade +$74.68; average losing trade -$139.09. Mean realized result against the original recorded entry stop-risk = -0.0683R (46/46 risk records were available pre-fill).

| Trial route | Settled | W / L | Broker-net USD | Profit factor | Mean net R |
|---|---:|---:|---:|---:|---:|
| CONFIRMED_REVERSAL | 39 | 24 / 15 | -62.66 | 0.9678 | -0.0316R |
| EARLY_TRANSITION | 7 | 4 / 3 | -350.05 | 0.3735 | -0.2730R |

| Instrument | Settled | Net USD |
|---|---:|---:|
| USDJPY | 13 | +317.74 |
| AUDUSD | 18 | -526.64 |
| USDCAD | 7 | -86.00 |
| EURUSD | 8 | -117.81 |

These are same-day observational data. Positive USDJPY performance does not authorize raising lots; negative AUDUSD does not independently justify a blanket instrument ban.

## Recorded close reason breakdown

The trial read-only reporter now includes three additional grouped economics objects: byCloseReason, byStrategyCloseReason, byStrategyInstrumentCloseReason. They contain settled broker-net, signed fees, and risk-normalized R. Close reason labels are application/broker-recorded categories, not independently provider-ACKed TP or SL deals.

| Close reason | Trades | W / L | Net USD | Mean net R |
|---|---:|---:|---:|---:|
| PROFIT_PROTECTION | 28 | 28 / 0 | +2,090.91 | +0.4263R |
| AI_CLOSE_SIGNAL | 10 | 0 / 10 | -927.18 | -0.6097R |
| BROKER_CLOSE | 8 | 0 / 8 | -1,576.44 | -1.1227R |

Early Transition: 4 protected winning closes +$208.66, 1 AI-close loss -$110.08, and 2 broker-close losses -$448.63. The average recorded BROKER_CLOSE costs far more than each protected winner. The immediate research need is verifying whether broker closes were actual SL events, margin stops or something else, including quotes, fees, slippage and original strategy-specific entry quality.

## Post-noon integrity verification

Added read-only script apps/api/scripts/audit-owner-demo-noon-expiry-integrity.cjs and six focused tests. It checks all owner-connection-scoped intents created after 12:00 UTC, expired trial artifacts on new intents, requested lots above 4, actual fills above 4, and delayed fills from pre-noon orders.

At 12:13:31 UTC, the first historical cross-check found one post-noon intent and fill, zero new intents bearing the expired trial artifact, zero requested lots above 4, zero filled lots above 4 and zero delayed pre-noon fills. It found no integrity exception in the then-observed records. The app's existing scheduler and position-sizing functions both check actual server time against 12:00 UTC; noon unit tests pass. This is not a broker-provider order log and does not provide an absolute guarantee.

The private read-only output is at /home/lightworld/webapps/irexpro-research/owner-noon-lot-trial/latest-expiry-integrity.json.

## Next evidence before changing trading

1. Verify native provider execution reasons, effective stop, price slippage and fees for all 18 losing trades. Avoid claiming every BROKER_CLOSE was a native stop-loss fill.
2. Observe forward-only, route-specific pre-intent features for Early Transition and Confirmed Reversal on untouched later trading days. Do not resurrect historical entry predictors that failed forward evaluation.
3. Compare profit-protection peak retention and later sampled TP/SL against actual risk and provider-side stop confirmations. Sampled hypothetical targets are not executable profits.
4. Keep all automated LIVE promotion, new broker SL amendments, strategy veto, and large-size permissions unchanged until validated and owner-controlled.

The existing half-hourly owner DEMO **read-only** research monitor also runs the expiry-integrity check during 12:00–16:00 UTC on the expiry day, without creating any additional timer or trading service. It expires its own integrity-polling window at 16:00. It neither disables nor enables strategy execution. The code module is not hot-reloaded; a restart of only that read-only monitor is needed to load it, leaving the trading API untouched.
