# Extension Exhaustion DEMO Scout Design

## Intent
Increase DEMO participation without weakening the general Plan-B/drift gates by promoting only extension-exhaustion pair/sides whose settled shadow outcomes demonstrate positive recent expectancy.

## Constraints
- DEMO only; LIVE remains fail-closed.
- Maximum requested volume 0.10 lot; downstream broker margin/risk sizing may reduce or reject further.
- Never bypass high-impact/unverified event risk, unusable execution costs, active opposite positions, fast-stop brakes, allocation/risk checks, or post-entry protection.
- Do not globally relax drift. Scout requires the extension specialist's own `TREND_EXTENDED` + `NORMAL` drift candidate state.
- M1 must time the entry with `M1_TREND_CONTINUATION` and strong confidence/quality.
- Pair/side evidence is recomputed from settled compatible Plan-B shadow outcomes, so qualification can turn on/off without code changes.

## Qualification
Pair/side reliability over the last 7 days, deduplicated into 15-minute episodes:
- >= 6 resolved episodes
- average net R >= 0.10
- profit factor >= 1.15
- sum of latest 3 net-R outcomes > 0

Current live evidence qualifies AUDUSD SELL only; qualification is dynamic and not hard-coded.

## Current-candidate requirements
- `extensionExhaustionShadow.candidate=true` semantics: regime `TREND_EXTENDED`, drift `NORMAL`, confidence >= 0.64, net expected R >= 0.08, direction quality >= 0.35, spread evidence valid.
- Additional DEMO scout requirements: event risk `CLEAR`, M1 route `M1_TREND_CONTINUATION`, M1 confidence >= 0.70, M1 direction quality >= 0.65, pair/side reliability qualified, trained experts not strongly opposed.
- portfolio snapshot must be available.

## Authority behavior
When ordinary Plan-B, M5 handoff, and existing professional fallback do not execute, the scout may become the authority path. It records an explicit scout governance artifact and uses a 0.10-lot cap. Existing duplicate-intent, opposite-position, loss/fast-stop, currency exposure, allocation, broker margin, risk and execution orchestration remain authoritative downstream.
