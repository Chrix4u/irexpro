# iRexPro GitHub-first runtime migration

## Scope and rollout
The current application entry remains `/home/lightworld/webapps/irexpro-staging`. This change is an isolated CI runtime pilot, not a live cutover. It builds the exact verified current trading source on GitHub with existing standalone build tools. The legacy SSH deployment explicitly invokes the shared host capacity guard before on-host builds. Never bypass a capacity hold.

## Publication and recovery gates
The current repository visibility is public. Private runtime publication is blocked until a verified private repository is available. Never transfer local unpublished source, live configuration, customer information, broker credentials, journals, model datasets, production backups or signing material. Build only from reviewed Git commits. Before a cutover, require checksum and source verification, archive safety validation, an isolated extraction and smoke test, production dependency and Python compatibility, migration rehearsal, shared runtime path/worker inventory, trading quiescence, operator approval, and a verified rollback. Retain active and previous release until recovery from GitHub-hosted artifacts is proven. Do not merge this operational pilot into main until the legacy deploy hold and replacement artifact route are reviewed together.

## Retention
Keep the existing weekly iRexPro-only cache timer. Old worktrees may be removed only after confirming remote reachability, clean tracked/untracked state, age >=14 days, no service/process reference and no private/ignored data. Use bounded batches with the existing cleanup lock. Preserve all databases, backups, runtime state, models and secrets. Keep a root-only inventory and before/after byte counts. No cleanup of other projects.

## Evidence required
Record the exact source SHA, CI run, archive checksum/size, independent recovery test, public and local health checks and retained rollback. A CI pilot is not proof of a migrated deployment.
