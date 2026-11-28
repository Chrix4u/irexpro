# iRexPro AI Engine V2 — DEMO evaluation environment (offline)

Date: 2026-11-28 · Branch: `research/ai-engine-v2-champion-challenger-20261127` (synced to main `ce447f47`) · Research-only.

## 1. What this environment is

The isolated Champion–Challenger evaluation environment requested for
independent review — delivered fully OFFLINE:

- **Environment assembly** (`v2-demo-evaluation-environment.cjs`): engine
  identities registered under `RESEARCH_SHADOW` (R2, generation 1 frozen);
  account-isolation and equivalent-starting-conditions contracts asserted
  fail-closed (R1, R4); authority audit shows no live authority exists
  anywhere in the research stack.
- **End-to-end runner** (`v2-demo-evaluation-run.cjs`): assembles the
  environment, revalidates every research contract (exit-engine paths,
  component-map paths, P1-6 reconciliation), runs the paired campaign,
  the null / known-edge / exit-dominance validation campaigns, loads the
  V1 broker evidence window, and writes four artifacts with SHA-256
  hashes. Byte-identical for a given seed — two runs must print the same
  hashes; that is the reviewer's first check.
- **Artifacts** (committed under `runs/v2-demo-evaluation-<seed>/`):
  `comparative-dashboard.html` (self-contained), `results.json` (full
  machine-readable evidence), `attribution-ledger.jsonl` (append-only
  ledger), `REVIEW-CHECKLIST.md`.

## 2. How to run it (independent review)

```sh
node apps/api/scripts/research/v2-demo-evaluation-run.cjs --seed 20261128
# ~2 seconds; prints the four SHA-256 artifact hashes.
# Rerun and compare hashes for byte-identical reproduction.
# Larger campaigns:
node apps/api/scripts/research/v2-demo-evaluation-run.cjs --seed 7 --null-replays 1000 --edge-trials 200
```

Full test suite (CI-verified, 13 workflow steps for the V2 stack):
`node --test apps/api/scripts/research/v2-*.test.cjs`

## 3. What the reviewer should verify (REVIEW-CHECKLIST.md)

1. Byte-identical reproduction (hash comparison).
2. Dashboard figures trace to `attribution-ledger.jsonl` (R6 single code path).
3. The four broker-evidence checks (net total, balance chain, realized
   match, duplicate guard) on the REAL statement window.
4. Null campaign false-positive rates at or below the 5% nominal.
5. Known-edge planted AUCs recovered within stated uncertainty at the
   predicted detection power.
6. Exit-dominance attribution ≥ 90% on both controlled arms.
7. Champion baseline mirror constants equal the audited S1 constants
   (frozen hash canary test).

## 4. Boundaries (binding)

- This is the OFFLINE part of P5's preparation. P5-1 (broker account
  provisioning), P5-2 (broker connection ids) and P5-3 (equivalence run)
  remain BLOCKED on this review; nothing here connects to, provisions or
  authorizes a broker.
- V1 remains the baseline; the champion mirror is hash-pinned and never
  modified. V2 is not promoted to LIVE and cannot be — no order
  authority exists in this stack.
- All paired results are synthetic and are NOT evidence of
  profitability; the only real performance datum (the V1 broker evidence
  window: 19 deals, net −442.49 USD) is reported exactly as the broker
  stated it.
