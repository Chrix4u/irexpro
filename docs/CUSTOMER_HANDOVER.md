# Customer handover and portable installation contract

Status: design and acceptance requirements; not certification of an existing customer release.

## One source of truth

Build from an immutable reviewed GitHub commit or signed release tag. The monorepo contains the web, admin, API and mobile apps, AI engine, MT5 connector, shared packages, infrastructure templates, lockfiles and migration code. Do not assemble a release by copying files from experimental worktrees or a running server.

## Distribution

Publish a versioned release manifest with the exact source SHA, supported OS and architecture, dependency and model provenance, artifact names, SHA-256 checksums, SBOM, migration compatibility and release notes. Use hosted CI to compile and test server artifacts, platform-specific installers and mobile packages. Use an explicit allowlist for distributable files.

The Linux server package must contain the built API, web and admin runtime, AI engine runtime, approved model files (or a checksum-pinned authorized fetch procedure), pinned runtime dependencies, database migration tooling, service/reverse-proxy templates, environment variable templates without credentials, install/upgrade/rollback tools and operator documentation. A container-image-based release may reference immutable image digests instead of embedding duplicated runtime dependencies. Existing compose and CI files are inputs, not evidence that all components are packaged.

Mobile and connector builds are associated platform-specific release assets, not production server build dependencies.

## Intended installed layout

A single stable application entry directory contains current and previous verified release references, immutable release contents and references to persistent configuration/data. Persistent database storage, secret management, certificates and protected backups may reside outside the application tree. Keep only the active and one proven compatible rollback release after a verified upgrade. Never bundle production database contents, credentials, customer records, broker tokens, private research evidence, signing keys or other tenants' files. Transfer source only if contractually authorized.

## Fresh-host acceptance

1. Verify signatures/checksums and release manifest before installation.
2. Provision an isolated clean server with supported runtime versions, fresh database and unique customer credentials; configure domain, TLS and broker test integration.
3. Run migration, startup, public/API health, authenticated user and admin workflows, AI model loading, demo lifecycle/reconciliation and recovery checks using synthetic or authorized demo data. No real-money activation for installation testing.
4. Rehearse upgrade and rollback against a compatible schema, and verify backup restore.
5. Record the exact release version, test results, operator instructions and support/licensing terms. Handover is complete only when this acceptance evidence exists.

## Deployment retention

Use the same exclusive lock for deploy and cleanup; resolve real service paths and references before deleting. Require verified GitHub recovery and a compatible rollback manifest. Fail closed for unknown files, active directories, unresolved sessions/orders, failed health checks or uncertain backup status. Record deletion paths and measured filesystem changes in restricted operational logs. Do not keep source worktrees on the production host.
