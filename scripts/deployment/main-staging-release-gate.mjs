import { requiredWorkflowNames } from '../security/required-ci-gate.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;
const DEFAULT_POLL_SECONDS = 15;
const DEFAULT_TIMEOUT_SECONDS = 2700;
const MAX_COMPARE_FILES = 300;

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

function assertFullSha(value, label) {
  if (!FULL_SHA.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
  }
}

async function githubJson(path, token, apiUrl) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'irexpro-main-staging-release-gate',
    },
  });

  if (!response.ok) {
    const requestId = response.headers.get('x-github-request-id') ?? 'unknown';
    throw new Error(
      `GitHub API request failed (${response.status}) for ${path}; request_id=${requestId}`,
    );
  }
  return response.json();
}

async function assertCurrentMain(repository, candidateSha, token, apiUrl) {
  const ref = await githubJson(`/repos/${repository}/git/ref/heads/main`, token, apiUrl);
  const current = ref.object?.sha ?? '';
  if (current !== candidateSha) {
    throw new Error(
      `Staging release candidate is no longer current main: expected ${candidateSha}, current ${current || 'unknown'}`,
    );
  }
}

async function assertMergedPullRequestProvenance(repository, candidateSha, token, apiUrl) {
  const pullRequests = await githubJson(
    `/repos/${repository}/commits/${candidateSha}/pulls?per_page=100`,
    token,
    apiUrl,
  );
  const mergedIntoMain = pullRequests.filter(
    (pullRequest) =>
      pullRequest.state === 'closed' &&
      Boolean(pullRequest.merged_at) &&
      pullRequest.base?.ref === 'main',
  );

  if (mergedIntoMain.length === 0) {
    throw new Error(
      `Staging release candidate ${candidateSha} is not associated with a merged pull request targeting main; direct/unprovenanced main pushes are not deployable`,
    );
  }

  console.log(
    `Merged PR provenance: ${mergedIntoMain.map((pullRequest) => `#${pullRequest.number}`).join(', ')}`,
  );
}

async function resolveBeforeSha(repository, candidateSha, token, apiUrl) {
  const supplied = process.env.BEFORE_SHA?.trim() ?? '';
  if (supplied && !ZERO_SHA.test(supplied)) {
    assertFullSha(supplied, 'BEFORE_SHA');
    return supplied;
  }

  const commit = await githubJson(`/repos/${repository}/commits/${candidateSha}`, token, apiUrl);
  const firstParent = commit.parents?.[0]?.sha ?? '';
  assertFullSha(firstParent, 'candidate first parent');
  return firstParent;
}

async function listChangedFiles(repository, beforeSha, candidateSha, token, apiUrl) {
  const comparison = await githubJson(
    `/repos/${repository}/compare/${encodeURIComponent(beforeSha)}...${encodeURIComponent(candidateSha)}`,
    token,
    apiUrl,
  );
  const files = comparison.files ?? [];
  if (files.length >= MAX_COMPARE_FILES) {
    throw new Error(
      `Main release diff reached the ${MAX_COMPARE_FILES}-file GitHub compare limit; refusing an incomplete release-policy decision`,
    );
  }
  return files.map((file) => file.filename);
}

async function listCandidateWorkflowRuns(repository, candidateSha, token, apiUrl) {
  const response = await githubJson(
    `/repos/${repository}/actions/runs?event=push&head_sha=${encodeURIComponent(candidateSha)}&per_page=100`,
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

function assertEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

export function runSelfTests() {
  assertFullSha('a'.repeat(40), 'self-test SHA');
  assertEqual(
    requiredWorkflowNames(['apps/api/src/main.ts']),
    ['Release Security', 'API CI', 'Risk Execution Concurrency'],
    'API main-release policy',
  );
  assertEqual(
    requiredWorkflowNames(['scripts/deployment/main-staging-release-gate.mjs']),
    ['Release Security', 'Deployment Script Safety'],
    'main staging release gate policy',
  );
  console.log('Main staging release gate self-tests passed.');
}

export async function runMainStagingReleaseGate() {
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const candidateSha = requiredEnvironment('CANDIDATE_SHA');
  const token = requiredEnvironment('GITHUB_TOKEN');
  const apiUrl = (process.env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/$/, '');
  const pollSeconds = positiveIntegerEnvironment('MAIN_RELEASE_POLL_SECONDS', DEFAULT_POLL_SECONDS);
  const timeoutSeconds = positiveIntegerEnvironment('MAIN_RELEASE_TIMEOUT_SECONDS', DEFAULT_TIMEOUT_SECONDS);

  assertFullSha(candidateSha, 'CANDIDATE_SHA');
  await assertCurrentMain(repository, candidateSha, token, apiUrl);
  await assertMergedPullRequestProvenance(repository, candidateSha, token, apiUrl);

  const beforeSha = await resolveBeforeSha(repository, candidateSha, token, apiUrl);
  const changedPaths = await listChangedFiles(repository, beforeSha, candidateSha, token, apiUrl);
  const requiredNames = requiredWorkflowNames(changedPaths);

  console.log(`Main candidate: ${candidateSha}`);
  console.log(`Previous main: ${beforeSha}`);
  console.log(`Changed files: ${changedPaths.length}`);
  console.log(`Required push workflows: ${requiredNames.join(', ')}`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastSummary = '';

  while (Date.now() <= deadline) {
    await assertCurrentMain(repository, candidateSha, token, apiUrl);
    const runs = await listCandidateWorkflowRuns(repository, candidateSha, token, apiUrl);
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
          `${name} failed the main staging release gate: conclusion=${run.conclusion ?? 'unknown'}, run_id=${run.id}`,
        );
      }
    }

    if (!waiting) {
      await assertCurrentMain(repository, candidateSha, token, apiUrl);
      console.log(`Main staging release gate passed for ${candidateSha}.`);
      console.log(`STAGING_RELEASE_AUTHORIZED_SHA=${candidateSha}`);
      return;
    }

    await sleep(pollSeconds * 1000);
  }

  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for required push workflows on ${candidateSha}`,
  );
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runMainStagingReleaseGate().catch((error) => {
    console.error(`Main staging release gate failed: ${error.message}`);
    process.exit(1);
  });
}
