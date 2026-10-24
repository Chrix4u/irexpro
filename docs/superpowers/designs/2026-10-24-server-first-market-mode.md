# Server-first AI market mode

## Intent
The `/trade` page must never render the normal AI trading workspace first and then switch to the weekend-closed screen. The initial HTML must already reflect the authoritative FX weekly session state.

## Chosen approach
Use one shared pure FX weekly-session utility from `@irexpro/types/market-schedule`. The trading API keeps its existing, already-regression-tested weekly boundary. The frontend-safe shared utility mirrors that same New York boundary, while the Next.js `/trade` Server Component evaluates the current schedule on every request (`dynamic = "force-dynamic"`) and passes it to the existing client workspace as initial state.

The client keeps the server schedule as durable state, replaces it when `/ai/external/vps-forex/status` returns a newer authoritative schedule, and never clears the schedule merely because a secondary status refresh fails.

## Rendering behavior
When the server says WEEKEND, the client renders the market-closed state immediately, even while authentication restoration is still in progress. Once auth is restored, the same closed state is wrapped in the authenticated dashboard shell. When the market is open, the existing workspace loads normally.

## Constraints
- FX boundary remains Sunday 17:00 New York through Friday 17:00 New York, DST-aware.
- Five-minute next-eligible-scan cadence remains unchanged.
- No trading authority or risk behavior changes.
- No static caching of the market-mode decision.
- Client polling remains responsible for transitions after initial page load.
