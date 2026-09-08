const REQUIRED_CONTEXT = 'Required CI Gate';

function assertEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

export function appliesToMain(ruleset) {
  if (ruleset?.target !== 'branch' || ruleset?.enforcement !== 'active') return false;
  const include = ruleset?.conditions?.ref_name?.include;
  if (!Array.isArray(include)) return false;
  return include.includes('refs/heads/main') || include.includes('~DEFAULT_BRANCH');
}

export function requiredStatusCheckRule(ruleset) {
  return Array.isArray(ruleset?.rules)
    ? ruleset.rules.find((rule) => rule?.type === 'required_status_checks') ?? null
    : null;
}

export function evaluateMainRuleset(ruleset) {
  const findings = [];

  if (!appliesToMain(ruleset)) {
    findings.push('ruleset must be active and apply to refs/heads/main');
    return findings;
  }

  const ruleTypes = new Set((ruleset.rules ?? []).map((rule) => rule?.type));
  for (const requiredType of ['pull_request', 'deletion', 'non_fast_forward']) {
    if (!ruleTypes.has(requiredType)) {
      findings.push(`missing ${requiredType} rule`);
    }
  }

  const statusRule = requiredStatusCheckRule(ruleset);
  if (!statusRule) {
    findings.push('missing required_status_checks rule');
    return findings;
  }

  const checks = statusRule?.parameters?.required_status_checks;
  if (!Array.isArray(checks)) {
    findings.push('required_status_checks.parameters.required_status_checks must be an array');
  } else if (!checks.some((check) => check?.context === REQUIRED_CONTEXT)) {
    findings.push(`missing required status context: ${REQUIRED_CONTEXT}`);
  }

  if (statusRule?.parameters?.strict_required_status_checks_policy !== true) {
    findings.push('strict_required_status_checks_policy must be true');
  }

  return findings;
}

export function runSelfTests() {
  const base = {
    id: 1,
    name: 'Require pull',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: {} },
    ],
  };

  assertEqual(appliesToMain(base), true, 'main applicability');
  assertEqual(
    evaluateMainRuleset(base),
    ['missing required_status_checks rule'],
    'missing status rule',
  );

  const loose = {
    ...base,
    rules: [
      ...base.rules,
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: REQUIRED_CONTEXT }],
        },
      },
    ],
  };
  assertEqual(
    evaluateMainRuleset(loose),
    ['strict_required_status_checks_policy must be true'],
    'strict policy required',
  );

  const wrongContext = {
    ...base,
    rules: [
      ...base.rules,
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'Release Security' }],
        },
      },
    ],
  };
  assertEqual(
    evaluateMainRuleset(wrongContext),
    [`missing required status context: ${REQUIRED_CONTEXT}`],
    'stable aggregator context required',
  );

  const valid = {
    ...base,
    rules: [
      ...base.rules,
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: REQUIRED_CONTEXT }],
        },
      },
    ],
  };
  assertEqual(evaluateMainRuleset(valid), [], 'valid ruleset');

  const defaultBranchToken = {
    ...valid,
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  };
  assertEqual(appliesToMain(defaultBranchToken), true, 'default-branch token');

  console.log('Main ruleset verifier self-tests passed.');
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function githubJson(path, token, apiUrl) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'irexpro-main-ruleset-verifier',
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

export async function verifyLiveRuleset() {
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const token = requiredEnvironment('GITHUB_TOKEN');
  const apiUrl = (process.env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/$/, '');

  const summaries = await githubJson(`/repos/${repository}/rulesets`, token, apiUrl);
  const details = [];
  for (const summary of summaries) {
    if (summary?.target !== 'branch' || summary?.enforcement !== 'active') continue;
    const detail = await githubJson(`/repos/${repository}/rulesets/${summary.id}`, token, apiUrl);
    if (appliesToMain(detail)) details.push(detail);
  }

  if (details.length === 0) {
    throw new Error('No active branch ruleset applying to main was found');
  }

  const evaluations = details.map((ruleset) => ({
    id: ruleset.id,
    name: ruleset.name,
    findings: evaluateMainRuleset(ruleset),
  }));
  const passing = evaluations.find((result) => result.findings.length === 0);
  if (!passing) {
    const summary = evaluations
      .map((result) => `ruleset ${result.id} (${result.name}): ${result.findings.join('; ')}`)
      .join(' | ');
    throw new Error(`main ruleset policy is not enforced: ${summary}`);
  }

  console.log(
    `main ruleset verification passed: ruleset ${passing.id} (${passing.name}) requires ${REQUIRED_CONTEXT} with strict status checks.`,
  );
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  verifyLiveRuleset().catch((error) => {
    console.error(`Main ruleset verification failed: ${error.message}`);
    process.exit(1);
  });
}
