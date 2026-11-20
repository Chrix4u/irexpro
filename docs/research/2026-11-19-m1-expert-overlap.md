# iRexPro — bounded M1 broker-trained expert request overlap

Date: 19 November 2026, owner DEMO performance research.

## Motivation

A read-only review of 220 recent slow candidate phase-latency logs showed
median candidate evaluation ~7.0 seconds, p90 ~12.7 seconds, with trained
expert model I/O median ~3.5 seconds, p90 ~7.3 seconds. The six-pair
scanner keeps risk and order checks serial; long model waits can delay
subsequent broker snapshots into the same or next minute.

## Change

After a completed broker market snapshot passes feature construction,
`processInstrument` starts one `evaluatePair` request for its exact
instrument, broker connection and minute boundary. That request is
independent of the macro-event-risk and history/reliability reads, so it
may overlap them. The two opposing candidates still await the same
request, receive separate BUY/SELL overlay classifications, and use
their existing serial portfolio, risk, broker eligibility and order
submission paths.

No result persists between instruments, minute slots or accounts. No
model authority or risk gate is changed, and a failed expert request
remains unavailable; there is no fallback to an old score. The original
broker-source and alignment checks remain in place.

The new `trainedExpertFetchMs` scan-timing field measures the *full
underlying model request*, including overlapped time. The previous
`trainedExpertMs` phase timing measures time spent awaiting the result
inside the candidate and should be interpreted as residual wait after
the prefetch, not model compute duration. Comparing both prevents
claiming speed improvements from relabeling wait time.

## Other VPS contention

Two long-running Pure-FTPd quota scans for `lightworld` were observed
concurrently for more than one hour, using substantial CPU and disk
reads on a heavily loaded, fully swapped VPS. Their process CPU nice
level was reduced from 0 to +15 and their disk I/O class set to IDLE,
a reversible runtime scheduling change that does not kill FTP scans or
affect broker risk settings. This is NOT evidence the M1 engine is
profitable or that all latency has been eliminated.

## Verification

Test that the model request starts before an unresolved macro assessment,
that both directional decisions share one request, and that missing
market data launches no expert call. Build and run the production API,
then compare actual scanner latency with new timing fields. Do not
promote to LIVE or infer better after-fee expectancy from latency alone.
