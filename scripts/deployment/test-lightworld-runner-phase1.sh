#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTROL="$REPO_ROOT/.github/workflows/vps-ops-control.yml"
DIAGNOSTIC="$REPO_ROOT/.github/workflows/vps-runner-diagnostic.yml"
STAGING_DEPLOY="$REPO_ROOT/.github/workflows/staging-deploy.yml"

fail() {
  printf 'TEST FAILURE: %s\n' "$1" >&2
  exit 1
}

[[ -f "$CONTROL" ]] || fail 'Missing iRexPro VPS ops control workflow.'
[[ -f "$DIAGNOSTIC" ]] || fail 'Missing iRexPro VPS runner diagnostic workflow.'

# Control channel: owner-only, issue-pinned, read-only, repo-scoped runner.
grep -Fq 'name: VPS Ops Control' "$CONTROL" || fail 'Control workflow name is missing.'
grep -Fq 'issue_comment:' "$CONTROL" || fail 'Control workflow must use issue comments.'
grep -Fq 'github.event.issue.number == 366' "$CONTROL" || fail 'Control workflow must be pinned to issue #366.'
grep -Fq "github.actor == 'Chrix4u'" "$CONTROL" || fail 'Control workflow must be pinned to the Chrix4u owner.'
grep -Fq "github.event.comment.author_association == 'OWNER'" "$CONTROL" || fail 'Control workflow must require OWNER association.'
grep -Fq 'runs-on: [self-hosted, linux, x64, lightworld-vps, staging, irexpro-staging]' "$CONTROL" || fail 'Control workflow must use the iRexPro runner labels.'
for command in status health disk runner-status; do
  grep -Fq "\"/vps ${command}\")" "$CONTROL" || fail "Missing allow-listed /vps ${command} command."
done
if grep -Eq '\beval\b|bash +-c|STAGING_SSH_|SSH_PRIVATE_KEY|secrets\.|lightworld-deploy-|lightworld-rollback-|pm2 +(restart|stop|delete|start)' "$CONTROL"; then
  fail 'Phase-1 control workflow exposes a forbidden mutation or secret/SSH path.'
fi
if grep -Fq 'uses: actions/checkout@' "$CONTROL"; then
  fail 'Control workflow must not checkout repository code onto the VPS runner.'
fi

# Diagnostic: manual, read-only, no code checkout and no SSH material.
grep -Fq 'name: VPS Runner Diagnostic' "$DIAGNOSTIC" || fail 'Diagnostic workflow name is missing.'
grep -Fq 'workflow_dispatch:' "$DIAGNOSTIC" || fail 'Diagnostic workflow must be manual-only.'
grep -Fq 'runs-on: [self-hosted, linux, x64, lightworld-vps, staging, irexpro-staging]' "$DIAGNOSTIC" || fail 'Diagnostic workflow must use the iRexPro runner labels.'
if grep -Eq 'uses: actions/checkout@|STAGING_SSH_|SSH_PRIVATE_KEY|secrets\.|sudo |pm2 +(restart|stop|delete|start)' "$DIAGNOSTIC"; then
  fail 'Diagnostic workflow must remain read-only and credential-free.'
fi

# Phase 1 MUST NOT replace the proven SSH staging deployment yet.
grep -Fq 'runs-on: ubuntu-24.04' "$STAGING_DEPLOY" || fail 'Phase 1 must leave the current hosted staging deploy runner unchanged.'
grep -Fq 'STAGING_SSH_HOST' "$STAGING_DEPLOY" || fail 'Phase 1 must leave existing SSH staging deployment intact until runner proof.'

printf 'Lightworld iRexPro runner Phase-1 contract tests passed.\n'
