# Main branch required-status enforcement

## Objective

Protect `main` with the repository's stable aggregator check, **Required CI Gate**, instead of requiring every path-scoped workflow individually.

The Required CI Gate already verifies the immutable pull-request head and waits only for workflows applicable to the changed paths. Making that single context required avoids deadlocking documentation-only or narrowly scoped pull requests on workflows that correctly do not run.

## Current repository-owned policy

The active `main` ruleset must retain:

- pull requests required
- branch deletion blocked
- non-fast-forward updates blocked
- no bypass actor for ordinary merges

It must additionally contain a `required_status_checks` rule with:

- context: `Required CI Gate`
- `strict_required_status_checks_policy: true`

GitHub documents the workflow required-check context as the **job name**. The job in `.github/workflows/required-ci-gate.yml` is intentionally named `Required CI Gate` and should remain stable.

## Administrator action

An authorized repository administrator must edit the active ruleset for `refs/heads/main` and enable required status checks. Select **Required CI Gate** as the required check and require the branch to be up to date before merging.

Do not require path-scoped checks such as API CI, Mobile CI, UI E2E, Database Migration Compatibility, Backup Restore Rehearsal, or Deployment Script Safety directly. The Required CI Gate already determines which of those are applicable to the exact pull-request head.

## Verification

After the administrator saves the ruleset, run the repository verifier with a token that can read repository rulesets:

```bash
GITHUB_REPOSITORY=christianagbotah/irexpro \
GITHUB_TOKEN='<authorized-token>' \
node scripts/security/verify-main-ruleset.mjs
```

The command succeeds only when an active branch ruleset applying to `main`:

- requires pull requests;
- blocks deletion;
- blocks non-fast-forward updates;
- requires the `Required CI Gate` context; and
- uses strict required-status checks.

For deterministic repository CI, run:

```bash
node scripts/security/verify-main-ruleset.mjs --self-test
```

The self-test does not call GitHub or require credentials.

## Evidence to record

For issue #95, record:

- ruleset ID and name;
- timestamp of the administrator change;
- screenshot or exported JSON showing the `required_status_checks` rule;
- successful output from `verify-main-ruleset.mjs`;
- one PR demonstrating that a failing Required CI Gate blocks merge; and
- one narrow PR demonstrating that non-applicable path-scoped workflows do not deadlock merge.

No credentials or tokens should be included in the evidence.