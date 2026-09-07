const WORKFLOW_RULES = [
  {
    name: 'Release Security',
    always: true,
  },
  {
    name: 'API CI',
    patterns: [
      'apps/api/**',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      '.github/workflows/api-ci.yml',
    ],
  },
  {
    name: 'Risk Execution Concurrency',
    patterns: [
      'apps/api/**',
      'pnpm-lock.yaml',
      'package.json',
      '.github/workflows/risk-concurrency.yml',
    ],
  },
  {
    name: 'Database Migration Compatibility',
    patterns: [
      'apps/api/src/database/migrations/**',
      'apps/api/scripts/validate-uuid-bridge.ts',
      'apps/api/scripts/validate-migration-scenario-d.ts',
      'apps/api/scripts/validate-migration-scenario-e.ts',
      'apps/api/scripts/validate-migration-scenario-f.ts',
      'pnpm-lock.yaml',
      'package.json',
      '.github/workflows/db-migration-compat.yml',
    ],
  },
  {
    name: 'Backup Restore Rehearsal',
    patterns: [
      'apps/api/src/database/**',
      '.github/workflows/backup-restore-rehearsal.yml',
      'docs/runbooks/sprint-48-operational-security-readiness.md',
    ],
  },
  {
    name: 'Deployment Script Safety',
    patterns: [
      'scripts/deployment/**',
      'docs/operations/staging-deployment.md',
      '.github/workflows/deployment-script-safety.yml',
    ],
  },
  {
    name: 'UI E2E',
    patterns: [
      'apps/web/**',
      'apps/admin/**',
      'packages/api-client/**',
      'packages/types/**',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      '.github/workflows/web-e2e.yml',
    ],
  },
  {
    name: 'Mobile CI',
    patterns: [
      'apps/mobile/**',
      'packages/api-client/**',
      'packages/types/**',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      '.github/workflows/mobile-ci.yml',
    ],
  },
];

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function pathMatchesPattern(path, pattern) {
  const placeholder = '__DOUBLE_STAR__';
  const regexSource = escapeRegExp(pattern)
    .replaceAll('**', placeholder)
    .replaceAll('*', '[^/]*')
    .replaceAll(placeholder, '.*');
  return new RegExp(`^${regexSource}$`).test(path);
}

export function requiredWorkflowNames(changedPaths) {
  return WORKFLOW_RULES.filter((rule) => {
    if (rule.always) return true;
    return changedPaths.some((path) =>
      rule.patterns.some((pattern) => pathMatchesPattern(path, pattern)),
    );
  }).map((rule) => rule.name);
}

function assertEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

export function runSelfTests() {
  assertEqual(
    requiredWorkflowNames(['README.md']),
    ['Release Security'],
    'docs-only PR',
  );
  assertEqual(
    requiredWorkflowNames(['apps/api/src/modules/auth/auth.service.ts']),
    ['Release Security', 'API CI', 'Risk Execution Concurrency'],
    'API change',
  );
  assertEqual(
    requiredWorkflowNames(['apps/api/src/database/migrations/123-example.ts']),
    [
      'Release Security',
      'API CI',
      'Risk Execution Concurrency',
      'Database Migration Compatibility',
      'Backup Restore Rehearsal',
    ],
    'database migration change',
  );
  assertEqual(
    requiredWorkflowNames(['scripts/deployment/deploy-staging.sh']),
    ['Release Security', 'Deployment Script Safety'],
    'deployment change',
  );
  assertEqual(
    requiredWorkflowNames(['apps/web/src/app/page.tsx']),
    ['Release Security', 'UI E2E'],
    'web change',
  );
  assertEqual(
    requiredWorkflowNames(['apps/mobile/src/screens/LoginScreen.tsx']),
    ['Release Security', 'Mobile CI'],
    'mobile change',
  );
  assertEqual(
    requiredWorkflowNames(['packages/api-client/src/index.ts']),
    ['Release Security', 'UI E2E', 'Mobile CI'],
    'shared API client change',
  );
  assertEqual(
    requiredWorkflowNames(['packages/types/src/index.ts']),
    ['Release Security', 'UI E2E', 'Mobile CI'],
    'shared types change',
  );
  assertEqual(
    requiredWorkflowNames(['package.json']),
    [
      'Release Security',
      'API CI',
      'Risk Execution Concurrency',
      'Database Migration Compatibility',
      'UI E2E',
      'Mobile CI',
    ],
    'root package change',
  );
  assertEqual(
    requiredWorkflowNames([
      'docs/runbooks/sprint-48-operational-security-readiness.md',
    ]),
    ['Release Security', 'Backup Restore Rehearsal'],
    'restore runbook change',
  );

  const rateLimited = new GitHubApiError({
    status: 403,
    path: '/actions/runs',
    requestId: 'test-request',
    retryAfterSeconds: 7,
    rateLimitRemaining: 0,
    rateLimitResetEpochSeconds: 1_700_000_000,
  });
  assertEqual(rateLimited.status, 403, 'GitHubApiError status');
  assertEqual(rateLimited.retryAfterSeconds, 7, 'GitHubApiError Retry-After');
  assertEqual(rateLimited.rateLimitRemaining, 0, 'GitHubApiError rate-limit remaining');

  console.log(`Required CI gate self-tests passed (${WORKFLOW_RULES.length} workflow rules).`);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveIntegerEnvironment(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function integerHeader(headers, name) {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class GitHubApiError extends Error {
  constructor({
    status,
    path,
    requestId,
    retryAfterSeconds = null,
    rateLimitRemaining = null,
    rateLimitResetEpochSeconds = null,
  }) {
    super(`GitHub API request failed (${status}) for ${path}; request_id=${requestId}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.path = path;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.rateLimitRemaining = rateLimitRemaining;
    this.rateLimitResetEpochSeconds = rateLimitResetEpochSeconds;
  }
}

async function githubJson(path, token, apiUrl) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'irexpro-required-ci-gate',
    },
  });

  if (!response.ok) {
    const requestId = response.headers.get('x-github-request-id') ?? 'unknown';
    throw new GitHubApiError({
      status: response.status,
      path,
      requestId,
      retryAfterSeconds: integerHeader(response.headers, 'retry-after'),
      rateLimitRemaining: integerHeader(response.headers, 'x-ratelimit-remaining'),
      rateLimitResetEpochSeconds: integerHeader(response.headers, 'x-ratelimit-reset'),
    });
  }
  return response.json();
}

async function listChangedFiles(repository, prNumber, token, apiUrl) {
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await githubJson(
      `/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      token,
      apiUrl,
    );
    files.push(...batch.map((file) => file.filename));
    if (batch.length < 100) return files;
  }
  throw new Error('Pull request changed-file list exceeds the supported 3000-file gate limit');
}

async function assertCurrentPrHead(
  repository,
  prNumber,
  candidateSha,
  token,
  apiUrl,
) {
  const pullRequest = await githubJson(
    `/repos/${repository}/pulls/${prNumber}`,
    token,
    apiUrl,
  );
  if (pullRequest.state !== 'open') {
    throw new Error(`Pull request #${prNumber} is no longer open`);
  }
  if (pullRequest.head?.sha !== candidateSha) {
    throw new Error(
      `Pull request head moved: expected ${candidateSha}, current ${pullRequest.head?.sha ?? 'unknown'}`,
    );
  }
}

async function listCandidateWorkflowRuns(repository, candidateSha, token, apiUrl) {
  const encodedSha = encodeURIComponent(candidateSha);
  const response = await githubJson(
    `/repos/${repository}/actions/runs?event=pull_request&head_sha=${encodedSha}&per_page=100`,
    token,
    apiUrl,
  );
  return response.workflow_runs ?? [];
}

function newestRun(runs, workflowName) {
  return runs
    .filter((run) => run.name === workflowName)
    .sort((a, b) => {
      const aTime = Date.parse(a.run_started_at ?? a.created_at ?? 0);
      const bTime = Date.parse(b.run_started_at ?? b.created_at ?? 0);
      if (aTime !== bTime) return bTime - aTime;
      return (b.id ?? 0) - (a.id ?? 0);
    })[0];
}

function summarize(requiredNames, runs) {
  return requiredNames.map((name) => {
    const run = newestRun(runs, name);
    if (!run) return `${name}=missing`;
    return `${name}=${run.status}/${run.conclusion ?? 'pending'}#${run.id}`;
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runGate() {
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const candidateSha = requiredEnvironment('CANDIDATE_SHA');
  const prNumber = requiredEnvironment('PR_NUMBER');
  const token = requiredEnvironment('GITHUB_TOKEN');
  const apiUrl = (process.env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(
    /\/$/,
    '',
  );
  const pollSeconds = positiveIntegerEnvironment('REQUIRED_WORKFLOW_POLL_SECONDS', 15);
  const timeoutSeconds = positiveIntegerEnvironment(
    'REQUIRED_WORKFLOW_TIMEOUT_SECONDS',
    2400,
  );

  await assertCurrentPrHead(
    repository,
    prNumber,
    candidateSha,
    token,
    apiUrl,
  );
  const changedPaths = await listChangedFiles(
    repository,
    prNumber,
    token,
    apiUrl,
  );
  const requiredNames = requiredWorkflowNames(changedPaths);

  console.log(`Candidate: ${candidateSha}`);
  console.log(`Changed files: ${changedPaths.length}`);
  console.log(`Required workflows: ${requiredNames.join(', ')}`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastSummary = '';

  while (Date.now() <= deadline) {
    await assertCurrentPrHead(
      repository,
      prNumber,
      candidateSha,
      token,
      apiUrl,
    );

    const runs = await listCandidateWorkflowRuns(
      repository,
      candidateSha,
      token,
      apiUrl,
    );
    const summary = summarize(requiredNames, runs);
    const summaryText = summary.join(' | ');
    if (summaryText !== lastSummary) {
      console.log(summaryText);
      lastSummary = summaryText;
    }

    let waiting = false;
    for (const name of requiredNames) {
      const run = newestRun(runs, name);
      if (!run || run.status !== 'completed') {
        waiting = true;
        continue;
      }
      if (run.conclusion !== 'success') {
        throw new Error(
          `${name} failed the required gate: conclusion=${run.conclusion ?? 'unknown'}, run_id=${run.id}`,
        );
      }
    }

    if (!waiting) {
      console.log(`Required CI Gate passed for ${candidateSha}.`);
      return;
    }

    await sleep(pollSeconds * 1000);
  }

  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for required workflows on ${candidateSha}`,
  );
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runGate().catch((error) => {
    console.error(`Required CI Gate failed: ${error.message}`);
    process.exit(1);
  });
}
