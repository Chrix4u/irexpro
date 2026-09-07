# CI Service-Container Image Pinning

## Purpose

GitHub Actions service and helper containers are part of the repository's CI supply chain. Version tags such as `postgres:16-bookworm` are mutable: the same repository revision could otherwise execute a different image at a later date without any code change.

Repository CI therefore pins container images by immutable SHA-256 digest and enforces that policy in `scripts/security/check-workflow-container-digests.mjs` through the Required CI Gate.

## Current PostgreSQL baseline

The PostgreSQL 16 Bookworm Docker Official Image is referenced as a readable tag plus immutable multi-platform index digest:

```text
postgres:16-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55
```

The digest was resolved from the Docker Official Image registry on 2026-09-06. The same reference is used for GitHub Actions PostgreSQL services and for the backup/restore rehearsal's disposable PostgreSQL client containers.

## Policy

1. Every literal GitHub Actions `image:` value must end in `@sha256:<64 hexadecimal characters>`.
2. Shell-driven helper containers must expose their image through an environment variable ending in `_CONTAINER_IMAGE`; that value is subject to the same digest requirement.
3. Expression-based container image references are rejected by the policy. The reviewed image identity must remain visible in the workflow diff.
4. A human-readable tag may be kept before the digest for maintenance context, but the digest is authoritative.
5. Do not update only one PostgreSQL service or helper reference. Server and client tooling must move together unless a PR explicitly documents and tests a compatibility reason for separating them.

## Controlled digest upgrade procedure

When the approved PostgreSQL image needs to move:

1. Resolve the desired tag from the Docker Official `postgres` image registry.
2. Record the current multi-platform **index digest**, not a single architecture's layer or platform-manifest digest.
3. Confirm that the tag still represents the intended PostgreSQL major release and Debian baseline.
4. Replace every matching service and helper-container reference in one reviewable PR.
5. Run `node scripts/security/check-workflow-container-digests.mjs --self-test` and then the full policy check.
6. Require the exact-head Database Migration Compatibility, Risk Execution Concurrency, Backup Restore Rehearsal, Release Security, and Required CI Gate workflows to pass where selected by the repository path matrix.
7. Review the PR diff for accidental changes outside CI/release infrastructure before merge.
8. Merge only the exact reviewed head SHA.

## Rollback

If the newly pinned image causes a CI regression, restore the last known-good digest in a new reviewed commit. Do not fall back to a mutable tag as a temporary workaround. The rollback candidate must pass the same exact-head CI gates before merge.
