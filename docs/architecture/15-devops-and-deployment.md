# 15 — DevOps and Deployment

## iRexPro — Current Release Path and Target Infrastructure Architecture

---

## 1. Purpose and document status

This document separates two things that must not be confused:

1. **Current verified release path** — controls that exist in the `Chrix4u/irexpro` repository today and are executable by operators.
2. **Future target-state architecture** — longer-term container, cloud, and orchestration goals that are not yet the authoritative deployment mechanism.

When there is any conflict between a future-state example and an executable workflow, script, or runbook, the executable repository control is authoritative.

Canonical operational references:

- `docs/operations/staging-deployment.md`
- `docs/runbooks/production-deployment-vps-webuzo.md`
- `scripts/deployment/deploy-staging.sh`
- `scripts/deployment/rollback-staging.sh`
- `.github/workflows/main-staging-release-gate.yml`
- `.github/workflows/staging-deploy.yml`
- `scripts/security/required-ci-gate.mjs`

---

## 2. Current verified repository topology

The current repository is a pnpm workspace built around the following major areas:

```text
irexpro/
├── apps/
│   ├── api/                   # NestJS API
│   ├── web/                   # Next.js user web app
│   ├── admin/                 # Next.js admin app
│   └── mobile/                # Expo / React Native mobile app
├── services/
│   └── ai-engine/             # current Python AI service implementation
├── packages/                  # shared TypeScript packages
├── infrastructure/
│   └── nginx/                 # reverse-proxy/security configuration
├── scripts/
│   ├── deployment/            # deterministic staging deployment/rollback controls
│   └── security/              # release/security policy checks
├── docs/
└── .github/workflows/
```

Older architecture references to separate `market-data`, `signal-engine`, `strategy-orchestrator`, `backtesting`, or `model-registry` Python services describe possible future decomposition, not the current executable topology.

---

## 3. Current release-tooling baseline

The verified release baseline is:

- **Node.js:** 22 (EAS mobile release profile currently pins Node `22.23.2`)
- **pnpm:** `10.34.5`
- **Repository package manager:** pnpm workspace
- **PostgreSQL CI baseline:** PostgreSQL 16 for migration and restore gates
- **GitHub Actions:** exact candidate SHA checkout and fail-closed workflow policies

A compatibility minimum documented elsewhere must not be interpreted as the currently verified release baseline.

Current examples should use pnpm, for example:

```bash
pnpm install --frozen-lockfile
pnpm --filter @irexpro/api build
pnpm --filter @irexpro/web build
pnpm --filter @irexpro/admin build
```

Do not substitute `npm ci` or an older Node image in release documentation unless a separately validated build path explicitly requires it.

---

## 4. Current CI model

The repository does **not** use a single generic `ci.yml` plus automatic `develop` → staging and `main` → production rollout.

Instead, verification is split into focused workflows and aggregated by the **Required CI Gate**.

Current workflow set includes:

| Workflow | Purpose |
|---|---|
| `api-ci.yml` | API validation for API-affecting changes |
| `risk-concurrency.yml` | execution/risk concurrency regression protection |
| `db-migration-compat.yml` | PostgreSQL migration compatibility scenarios |
| `backup-restore-rehearsal.yml` | synthetic and migrated application-schema disaster-recovery rehearsal |
| `mobile-ci.yml` | mobile tests, typecheck, release-config validation, bundle smoke |
| `web-e2e.yml` | web/admin UI E2E verification |
| `nginx-security-policy.yml` | reverse-proxy/security policy validation |
| `deployment-script-safety.yml` | deterministic deployment/rollback safety tests |
| `release-security.yml` | release security, CodeQL, dependency, SBOM, secret and policy checks |
| `required-ci-gate.yml` | exact-head aggregator for all workflows applicable to the PR |
| `main-staging-release-gate.yml` | verifies an exact merged `main` SHA before staging CD can proceed |
| `staging-deploy.yml` | deploys an authorized exact `main` SHA to staging when staging CD is enabled |

`Required CI Gate` determines required workflows from the changed-file matrix in `scripts/security/required-ci-gate.mjs`. The corresponding workflow path filters are drift-checked so the aggregator and individual workflow triggers cannot silently diverge.

A green individual workflow is not by itself a release authorization if the Required CI Gate for the exact PR head is still pending or red.

---

## 5. Exact-SHA release authority

The current release model is deterministic and SHA-bound.

### 5.1 Pull request verification

For an ordinary change:

1. A PR is opened against `main`.
2. Path-scoped workflows execute against the exact PR head SHA.
3. `Release Security` runs as a mandatory security control.
4. `Required CI Gate` waits for every applicable exact-head workflow.
5. A failed, cancelled, stale, missing, or moved-head workflow is not accepted as release evidence.
6. Only the verified head should be merged.

### 5.2 Post-merge staging authorization

After merge:

1. `Main Staging Release Gate` evaluates the exact current `main` SHA.
2. It derives the required post-merge verification set and refuses a superseded SHA.
3. `Staging Deploy` is eligible only after that gate succeeds and repository variable `STAGING_CD_ENABLED=true`.
4. The deployment runner and staging VPS both verify that the candidate is still the exact authoritative `origin/main` SHA before runtime mutation.

This is different from the older design that implied "merge to develop = staging deployment".

---

## 6. Current staging deployment

The authoritative staging deployment path is the VPS path implemented by:

- `.github/workflows/staging-deploy.yml`
- `scripts/deployment/deploy-staging.sh`
- `scripts/deployment/rollback-staging.sh`
- `docs/operations/staging-deployment.md`

Current staging characteristics include:

- target root: `/home/lightworld/webapps/irexpro-staging`
- PM2 processes:
  - `irexpro-api-staging`
  - `irexpro-web-staging`
  - `irexpro-admin-staging`
- build completes before runtime mutation;
- API liveness/readiness/aggregate health is checked before dependent app restart;
- Web/Admin local readiness uses bounded retries and fails closed on exhaustion;
- public smoke checks remain mandatory;
- deployment origin/provenance is verified;
- rollback origin provenance is verified before trusting `origin/main`;
- secrets and SSH material are not committed to the repository.

Operators must follow the canonical staging runbook rather than architecture examples from an older pipeline design.

---

## 7. Production deployment status

The long-term architecture includes immutable images, orchestrated rollout, canary strategy, managed cloud services, and automated rollback. Those are **future-state goals unless and until executable repository controls implement them**.

Current documentation must not imply that:

- `production-deploy.yml` exists when it does not;
- `rollback.yml` exists when it does not;
- a merge to `main` automatically mutates production;
- a container-registry canary rollout is currently active;
- a rollback time objective is guaranteed by an automation that has not been implemented.

Production operations must use the current VPS/Webuzo runbook and the repository controls that are actually present.

---

## 8. Broker environment and production-LIVE eligibility

Environment name alone does **not** authorize live trading.

The following statement is intentionally rejected:

> Production environment = all broker providers are live-enabled.

Production-LIVE eligibility is provider/identity specific and must remain fail closed. It depends on the current broker governance and certification controls, including the relevant registered adapter, provider identity, catalog/certification state, evidence requirements, environment consistency, credential/session authority, account snapshot freshness, RiskGrant, and final dispatch checks.

A broker/provider can be present in production while still being ineligible for NEW_EXPOSURE live dispatch.

No architecture document may upgrade `NOT_CERTIFIED`, legacy-only, incomplete, or otherwise insufficient evidence into a current production-LIVE certification. Real certification evidence must be produced by the authorized operator process and must not contain credentials or secrets.

DEMO/PAPER semantics must remain separate from production-LIVE eligibility.

---

## 9. Database migrations and recovery

Database changes are reviewed as code and validated through PostgreSQL-focused CI.

The current repository verifies:

- complete discovered migration-chain compatibility on PostgreSQL 16;
- UUID extension/default behavior required by current migrations;
- existing-database upgrade scenarios;
- domain/FK/CHECK enforcement scenarios;
- synthetic `pg_dump` / `pg_restore` behavior;
- `pg_dump` / `pg_restore` of the **actual migrated iRexPro schema**;
- restored migration tracking and representative sanitized domain rows;
- destruction of raw CI dump files before artifact upload.

Migration/recovery CI uses disposable data only. Production data, credentials, OAuth material, broker secrets, and user PII are not valid test fixtures.

Destructive production migrations require explicit operational review; CI success is necessary evidence but is not by itself permission to mutate production data.

---

## 10. Secrets and deployment credentials

Secrets are never committed to source control.

Examples of sensitive values that must remain external to source include:

```text
DATABASE_URL
REDIS_URL
JWT_PRIVATE_KEY
JWT_PUBLIC_KEY
broker/provider credentials
OAuth client secrets/tokens
SSH private keys
KMS/encryption keys
payment-provider secret keys
```

GitHub deployment secrets and host keys belong in the appropriate GitHub Environment or other authorized secret store. Release scripts must fail closed when required secret material is absent.

Public configuration such as an API base URL may be committed only when it contains no secret and its environment meaning is explicit.

---

## 11. Rollback — current versus target state

### Current staging rollback

Use `scripts/deployment/rollback-staging.sh` and the staging operations runbook. The script validates repository origin/provenance before fetch or rollback-target trust.

Do not use an example such as:

```bash
gh workflow run rollback.yml
```

because `rollback.yml` is not the current executable rollback authority.

### Future target state

A future immutable/container rollout may provide automated canary rollback, version promotion, and explicit rollback SLOs. When implemented, those controls must be added to the repository and verified before this document describes them as current behavior.

---

## 12. Current AI service topology

The executable repository currently uses `services/ai-engine` as the Python AI service implementation.

Future decomposition may introduce separately deployable services such as market data, signal generation, strategy orchestration, backtesting, or model registry. Until those services exist and have their own tested release controls, they are architectural targets only.

Any future split must define:

- explicit service ownership and API contracts;
- independent health/readiness behavior;
- versioned schema/event contracts;
- deterministic build/release provenance;
- secret isolation;
- observability and failure containment;
- deployment and rollback authority.

---

## 13. Future target-state infrastructure

The following remains a long-term direction, not a statement of the currently deployed platform:

- immutable application images;
- managed container registry;
- ECS/EKS or equivalent orchestration;
- managed PostgreSQL with HA;
- managed Redis with HA;
- cloud secret manager/KMS;
- load balancer and private service networking;
- CDN/object storage where appropriate;
- centralized metrics, logs and alerting;
- progressive/canary deployment with automated rollback after proven health criteria.

A future AWS-oriented topology may use RDS, ElastiCache, ECR, ALB, Route 53, CloudFront, S3, CloudWatch and/or EKS/ECS, but none of those components should be treated as active release authority until implemented and validated.

---

## 14. Operator checklist

Before treating a change as staging-ready, verify:

1. the PR head SHA is the one reviewed;
2. all workflows required for the changed paths are green;
3. `Required CI Gate` is green for that same head SHA;
4. the PR has not moved after verification;
5. the exact verified head is merged;
6. the post-merge `Main Staging Release Gate` authorizes the exact current `main` SHA;
7. staging deployment, when enabled, uses only the canonical exact-SHA scripts/runbook;
8. public and local health/smoke checks succeed;
9. no deployment result is treated as production-LIVE broker certification evidence;
10. any failure remains visible and is not hidden by an unsafe automatic fallback.

---

## 15. Change-control rule for this document

Whenever executable workflows, release scripts, repository identity, verified Node/pnpm baseline, service topology, or broker certification policy changes materially, this document should be updated in the same release train.

Future architecture may be ambitious, but current operational truth must remain unambiguous.
