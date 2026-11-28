# iRexPro AI Engine V2 — sensitive-data remediation record (2026-11-28)

Status: research-only governance record for the V2 research line
`research/ai-engine-v2-champion-challenger-20261127` (PR #846). This document
inventories the broker-statement details that entered public research
artifacts, applies sanitization, and proposes — but does NOT unilaterally
execute — a secure history remediation plan (shared history is not rewritten
without the owner's explicit decision). `executionAuthority: NONE`.

---

## 1. Exposure inventory (what entered the public repo)

| Item | Introduced by | Content | Status now |
| --- | --- | --- | --- |
| `apps/api/scripts/research/fixtures/v2-broker-evidence-statement-09-20261110.csv` | commit `b940a9d7` (2026-11-28), LF-normalized in `fdb33b24` | 19 real cTrader DEMO deal rows: real deal IDs (`DID…`), real order IDs, ms-precision timestamps, symbols, prices, quantities, per-deal net USD, running balance chain, account summary block (balance/equity 42,404.16 at export) | **replaced by the sanitized fixture in this commit** (see §2) |
| `runs/v2-demo-evaluation-20261128/results.json` | commit `91c7e644` | embedded copy of the 19 real deal records + the split-second pair IDs | **regenerated from the sanitized fixture in this commit** |
| `runs/v2-demo-evaluation-20261128/comparative-dashboard.html` | commit `91c7e644` | inline mention of the split-second pair by real deal ID | **regenerated** |
| `apps/api/scripts/research/v2-broker-evidence-window.test.cjs` | commits `b940a9d7`/`fdb33b24` | pinned the two real deal IDs as the split-second-pair expectation | **re-pinned to synthetic IDs in this commit** |

Reach: the branch is pushed to `origin` (public to everyone with repo read
access) and is attached to open PR #846. PR comments were audited: **no raw
identifiers were posted in PR comments** (checked 2026-11-28; the comment
evidence cites aggregate window statistics only).

## 2. What was NOT exposed

- No account holder name, login, account number, broker server name, or
  credentials — the trimmed CSV the operator supplied contains none of
  these, and none were committed.
- No LIVE-account data: the statement is a Pepperstone **DEMO** account
  extract (window 2026-11-10; export 2026-11-28). No funds are at risk.
- No API keys, tokens, or private datasets from any other V2 artifact.

## 3. Sanitization applied (this commit)

- Deal IDs and order IDs are replaced with deterministic synthetic sequence
  IDs (`DID-S00001..DID-S00019`, `ORD-S00001..ORD-S00019`).
- **Every economic field is byte-identical to the operator upload**:
  symbol, direction, opening/closing timestamps (ms), entry/closing prices,
  quantities, per-deal Net USD, the running Balance USD chain, the total
  row, and the Summary/Balance block. The four-way reconciliation (net
  total, balance chain, realized match, duplicate guard), the friction
  analysis, and the window-vs-account gap therefore keep their previously
  validated values exactly (net −442.49; 4/4 verification; gap −7,153.35;
  median implied friction unchanged).
- The real-to-synthetic identifier mapping is retained **offline only** by
  the operator (`scripts/sanitization-id-mapping.txt` in the working
  environment, never committed). The original upload itself
  (`statement-09_44 28.11.2026.csv`) stays offline; its SHA-256 remains
  recorded as provenance in `EVIDENCE_PROVENANCE.originalUploadSha256`.
- Regression guards added: the evidence test now refuses any non-synthetic
  deal/order ID pattern in the fixture (`/^DID-S\d{5}$/`, `/^ORD-S\d{5}$/`)
  and fails if a raw `DID3…` identifier reappears.
- The offline sanitizer (`scripts/sanitize-statement-fixture.py` in the
  working environment) verifies field-by-field that only identifiers
  changed.

## 4. Residual Git-history exposure and remediation options

The raw fixture remains reachable in the pushed branch's Git history
(commits `b940a9d7`, `fdb33b24`, and the artifacts of `91c7e644`), and in
PR #846's head refs, until purged. Deleting the file now does not rewrite
history. Options, in escalating order of disruption:

- **R-A (default, recommended): squash-merge + branch delete.** PR #846 is
  merged with a squash commit (the house merge pattern already used for
  #870/#874), so `main` receives only the sanitized tree; immediately after
  merge, delete the remote branch `research/ai-engine-v2-champion-challenger-20261127`
  and the PR head refs. GitHub retains unreachable objects internally for a
  period (dangling-ref retention; cached PR diffs may persist until the PR
  is closed and garbage-collected) — this reduces but does not zero
  exposure.
- **R-B (operator decision required): coordinated history rewrite.**
  `git filter-repo` (text replacement of the 19 deal IDs / 19 order IDs
  across history) + force-push by the owner, applied to this branch only,
  plus a GitHub support request to purge cached views. This is the only
  complete purge. It rewrites SHAs and requires re-opening PR #846;
  **not executed unilaterally** — shared-history rewrite needs the owner's
  explicit go-ahead (per directive: "propose a secure remediation plan
  without rewriting shared history unilaterally").
- **R-C (cheap, effective for linkage): DEMO account rotation.** Re-provision
  a fresh Pepperstone DEMO account for all future broker-connected
  evidence windows (P5 provisioning is already planned to use fresh,
  isolated accounts). Published identifiers then cannot be linked to any
  future account activity even while old objects linger in history.
- **R-D (operational hygiene): keep the original statement offline-only**
  going forward; any future evidence fixture enters the repo only through
  this sanitizer (IDs replaced; economics preserved), or fully synthetic.

Recommendation: apply R-A + R-C now; treat R-B as optional owner decision
weighing the low residual sensitivity (DEMO identifiers, no PII, no
credentials) against the disruption of a shared-history rewrite.

## 5. Standing constraints reaffirmed

- V2 stays research-only (`executionAuthority: NONE`); no LIVE authority, no
  broker provisioning, no production changes.
- The evidence window remains a descriptive, broker-confirmed record — never
  a profitability claim, never mixed with synthetic results, never used to
  calibrate the challenger.
- No private datasets in the public repo; synthetic/sanitized fixtures only.
