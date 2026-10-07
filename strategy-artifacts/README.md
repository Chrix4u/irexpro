# Frozen strategy artifacts

This directory is intentionally empty until a strategy has passed every formal PAPER promotion gate.
A frozen artifact is **not** created merely because research or shadow diagnostics look promising.

Use:

```bash
node scripts/strategy/frozen-artifact.mjs --freeze descriptor.json strategy-artifacts/<name>.artifact.json
node scripts/strategy/frozen-artifact.mjs --verify-one strategy-artifacts/<name>.artifact.json
```

The freezer refuses descriptors unless `demoReviewEligible=true`, `strategyFrozen=true`, and every formal promotion check is true.
It stores SHA-256 hashes of the exact source/config files and a deterministic digest of the manifest.

## Promotion rule

The exact frozen artifact must move through these environments without strategy mutation:

1. Research PAPER (qualification evidence)
2. Broker-Parity PAPER (broker-native market data, simulated orders)
3. DEMO (broker-native market data and DEMO execution)
4. LIVE (same artifact after DEMO validation)

Each stage has a separate evidence cohort. A strategy change creates a new version and starts fresh qualification evidence.
Twelve Data research data must never silently substitute for broker-native data in Broker-Parity PAPER, DEMO, or LIVE.
