# Required CI Gate resilience

The Required CI Gate remains fail-closed, but transient GitHub API/network failures are retried by `scripts/security/required-ci-gate-runner.mjs`.

## Retry policy

The runner retries only transient failures:

- HTTP 408, 425, 429
- HTTP 5xx
- HTTP 403 only when GitHub identifies the response as rate-limited through `Retry-After` or exhausted rate-limit metadata
- recognized fetch/socket/DNS/connect timeout failures

It does **not** blindly retry ordinary 4xx responses. Permission/authentication 403s, 404s, pull-request head changes, failed required workflows, invalid configuration, and other application errors fail immediately.

Defaults:

- 5 attempts
- 2 second initial delay
- exponential backoff capped at 20 seconds for ordinary transient failures
- GitHub `Retry-After` / rate-limit reset hints can extend the delay beyond that normal backoff cap
- one shared 2400 second overall polling deadline

Environment overrides:

- `REQUIRED_GATE_API_RETRY_ATTEMPTS`
- `REQUIRED_GATE_API_RETRY_BASE_SECONDS`
- `REQUIRED_GATE_API_RETRY_MAX_SECONDS`
- `REQUIRED_WORKFLOW_TIMEOUT_SECONDS`

The lower-level gate preserves only non-sensitive API response metadata needed for retry decisions: HTTP status, request id, `Retry-After`, rate-limit remaining, and rate-limit reset. Tokens and response bodies are never included in retry errors.

The runner shortens the underlying gate timeout on every retry so retries never reset the overall deadline. A server-provided rate-limit delay is also bounded by that same deadline.

## Verification

`required-ci-gate-runner.mjs --self-test` proves:

- 408/425/429/5xx retry classification
- network timeout retry classification
- ordinary 403/404 fail immediately
- rate-limited 403 retries
- `Retry-After` delay handling
- rate-limit reset delay handling
- normal exponential backoff cap

The original `required-ci-gate.mjs --self-test` remains authoritative for required-workflow path selection and also verifies preservation of rate-limit metadata on `GitHubApiError`.

A persistent API failure still fails the gate after the bounded retries. A real required-workflow failure fails immediately without retry.
