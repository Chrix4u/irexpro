# iRexPro AI Engine V2 — P1-6 redundant-code inventory

Date: 2026-11-28 · Branch: `research/ai-engine-v2-champion-challenger-20261127` (synced to main `ce447f47`) · Research-only.

Executable mirror: `apps/api/scripts/research/v2-redundant-code-inventory.cjs` (+ `.test.cjs`, CI step in `api-ci.yml`). The scanner is mechanical, deterministic (sorted output), and reconciles against the pinned audit findings (A6/A9/D4) on every run; a pinned fact that disappears from the live tree is a reconciliation failure, and new findings are recorded as extras.

**Scope: proposal only.** Nothing is deleted or edited by the V2 research
branch. The removal list below is staged for a separately reviewable
cleanup PR — never mixed with research docs (P1-6 acceptance).

## Mechanical findings on the synced baseline (2026-11-28 scan)

### A6 — unimportable research modules (6 dead references, 5 files)

| File | Dead import | Detection |
| --- | --- | --- |
| `bounded_final_campaign.py` | `single_pair_v41_live_promotable_microstructure` | direct |
| `bounded_final_campaign.py` | `single_pair_v42_side_meta_label` | direct |
| `six_pair_v74_micro_ev_router.py` | `quote_microstructure` | direct |
| `six_pair_v74_quote_profitability_router.py` | `quote_microstructure` | direct |
| `six_pair_v75_quote_sleeve_router.py` | `quote_microstructure` | direct |
| `six_pair_v75_pair_specialists.py` | (imports the dead v74 router) | transitive |

All five audit-named files reproduce; the scanner adds the transitive case
(`v75_pair_specialists` imports `six_pair_v74_quote_profitability_router`,
which itself imports the never-committed `quote_microstructure`) — the file
is unimportable exactly like the audit states, now proven mechanically.

### A9 — deprecated re-export-only shims (1)

- `apps/api/src/modules/ai/multimodel-demo-authority.ts` — 13 lines,
  `@deprecated` re-export shim over `./multimodel-authority` (audit A9:
  "no separate DEMO model implementation").

### D4 — duplicate exported constants

The pinned group: literal `'0.2'` under `PAPER_PRODUCT_PREFERRED_LOT` and
its alias `PAPER_PRODUCT_ABSOLUTE_MIN_LOT` in
`execution/services/position-sizing.service.ts` (l.190-192) — the audit's
lot-preference duplication. The full mechanical scan reports **45
duplicate-constant groups** across the ai + execution modules (same
literal under ≥2 exported names, including numeric floors like `0.2` and
`0.25` with 15 and 8 names respectively) — each requires manual review
before any consolidation; semantic identity is not asserted by the
scanner, only literal identity.

### Additional mechanical categories (candidates, not verdicts)

- **Unused-export candidates: 459** across the ai + execution production
  files (exported symbols never referenced by any other production file;
  coarse token-level reference check — decorators, dynamic access and
  cross-app usage are out of scope, so each candidate requires manual
  review before removal).
- **Near-duplicate file pairs: 0** at token-Jaccard ≥ 0.75 over the
  component map's 64 path-verified files (comments stripped, identifiers
  normalized) — the six exit engines and six reversal definitions are
  semantically redundant per P1-5/P1-2 but not copy-paste redundant at the
  token level.

## Removal-list proposal (for the separately reviewable cleanup PR)

1. Delete or quarantine the five A6 research scripts (or commit their
   missing dependencies) — they cannot be imported as committed.
2. Replace the A9 shim `multimodel-demo-authority.ts` with direct imports
   of `./multimodel-authority` at call sites.
3. Consolidate the D4 `'0.2'` lot constants in `position-sizing.service.ts`
   into one exported name with documented aliases.
4. Review the 459 unused-export candidates file-by-file; expect a large
   false-positive share (spec-only helpers, decorator-registered classes) —
   removal only with per-symbol proof.

None of the above is performed by this branch.

## Acceptance criteria (verified by tests)

- [x] The scan reproduces every pinned A6 dead import (five files) plus
  the transitive case.
- [x] The scan reproduces the A9 shim.
- [x] The scan reproduces the D4 duplicate-constant group with the two
  pinned names attributed to `position-sizing.service.ts`.
- [x] Reconciliation of the live scan is green; tampering with pinned
  facts is a typed refusal; empty scans refuse.
- [x] The near-duplicate pass is deterministic and bounded.
- [x] The proposal renderer emits the removal list explicitly marked
  "proposal only".
- [x] No file outside `docs/research/`, `apps/api/scripts/research/` and
  `.github/workflows/api-ci.yml` is touched by this delivery.
