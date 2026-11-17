# iRexPro guarded Trend Continuation pullback + AI chart follow — 17 November 2026

## Decision and boundaries

The user requested a smarter, now-enabled Trend Continuation recovery after the overextended USDCAD BUY screenshot and requested that the price chart automatically follow the AI's focused instrument. This is a controlled **owner-scoped Pepperstone cTrader USD DEMO** continuation experiment, never a LIVE promotion or a blanket OOD-gate removal.

### Evidence of the USDCAD block

At 01:22 UTC on 17 Nov 2026, the owner's USDCAD BUY scan was Plan-B `TREND_CONTINUATION`, regime `TREND_EXTENDED`, `paperAdmitted=false`, with extension **3.37 ATR**, RSI **85.14**, directionally aligned EMA separation **1** (normalized), and OOD diagnostics `extensionAtr:HARD_HIGH`, `emaSeparation:HARD_HIGH`, `rsi14:HARD_HIGH`, and `volatilityScore:STRESSED_LOW`. The price was too extended for a justified fresh BUY, despite >0.67 model confidence. The goal is **not** to chase that price.

### New guard: `pepperstone-demo-guarded-pullback-v1`

The existing continuation pause stays **on**. When `IREXPRO_PEPPERSTONE_DEMO_GUARDED_PULLBACK=enabled` is configured, the scanner may lift that pause **only for the single admitted, owner-scoped, actual Pepperstone USD DEMO continuation candidate** that satisfies *all* of:

* A previously persisted **same-instrument, same-direction** `TREND_EXTENDED` M1 decision with broker-native extension >=1.50 ATR **2–25 minutes before** the new entry; source reads are bounded to the entry's as-of timestamp
* The **current** Plan-B `TREND_CONTINUATION` is `TREND_HEALTHY`, independently **paper admitted and governance eligible** with a real portfolio snapshot and **IN_DISTRIBUTION/NORMAL drift**
* The trend's current extension has cooled to **0.10–1.05 ATR**, RSI **35–65**, aligned EMA separation **0.12–1.35 ATR**, aligned M15 >=0.18
* M1 currently confirms `M1_TREND_CONTINUATION`, confidence >=0.68, direction quality >=0.66, M1 momentum (1/3 ATR) >=0.08/0.26, last completed aligned M5 body pressure >=0.10
* A fresh independent broker-native trained expert votes for the **same side** with at least two supporting votes and no more than one opposing vote; maximum freshness 120 seconds
* Event risk CLEAR, spread evidence valid, costs usable, expected net R >=0.15 and target distance >=1.25 times stop distance

The original active account, 0.25% per-position stop-risk cap, exposure limits, existing same-side intent deduplication, currency correlation, model loss streaks and portfolio net-drawdown brakes still apply. **Volume is capped at 0.20 lots**, before the existing broker-risk sizer can reduce it further. No future price bar or OOD continuation can be interpreted as a recovery signal; unavailable historical data does not grant an entry.

This is a narrowly-scoped **continuation pause exception**, not a new ungoverned trading path. No qualified recovered trade has been claimed without an actual broker fill.

### Post-entry profit protection

An actual entry through this exception is immutably tagged `m1_guarded_pullback_continuation=true` on its trade intent. The **existing Pepperstone DEMO after-fee profit manager** now accepts these tagged positions at peaks >=0.50R, requiring independent verified broker identity, original SL/TP, valid as-of commission samples and a 55%-of-peak broker-net floor plus the conservative extra cost reserve. The old untagged continuation policy is unchanged. It can request an owned `PROFIT_PROTECTION` close, but like any market close **cannot guarantee exact realized P&L or a perfect TP**.

### Chart auto-follow

The DEMO chart follows **the instrument in the AI trade-readiness focus** whenever that focus *changes* to an instrument in the authenticated current DEMO execution universe. It preserves manual chart selection while the AI focus remains unchanged, ignores unsupported/research-only instruments, clears stale candles on selection changes, and retains manual timeframe selection. This is UI-only and grants no trading authority.

### Deployment

Production API/Next build and test results must be recorded before enablement. The existing `IREXPRO_PEPPERSTONE_DEMO_PAUSE_TREND_CONTINUATION` remains enabled; the new pullback feature switch is a separate explicit opt-in. Check PM2 startup and observed as-of decisions before claiming successful operation.
