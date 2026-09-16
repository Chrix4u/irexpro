import { readFileSync } from 'node:fs';

const GATE_PATH = 'scripts/security/required-ci-gate.mjs';

export const WORKFLOW_FILES = new Map([
  ['Release Security', '.github/workflows/release-security.yml'],
  ['API CI', '.github/workflows/api-ci.yml'],
  ['Risk Execution Concurrency', '.github/workflows/risk-concurrency.yml'],
  [
    'Database Migration Compatibility',
    '.github/workflows/db-migration-compat.yml',
  ],
  [
    'Backup Restore Rehearsal',
    '.github/workflows/backup-restore-rehearsal.yml',
  ],
  [
    'Deployment Script Safety',
    '.github/workflows/deployment-script-safety.yml',
  ],
  ['Nginx Security Policy', '.github/workflows/nginx-security-policy.yml'],
  ['UI E2E', '.github/workflows/web-e2e.yml'],
  ['Mobile CI', '.github/workflows/mobile-ci.yml'],
]);

export function extractGateRules(source) {
  const matrixMatch = source.match(
    /const\s+WORKFLOW_RULES\s*=\s*\[([\s\S]*?)\n\];/,
  );
  if (!matrixMatch) {
    throw new Error('Unable to locate WORKFLOW_RULES in required CI gate');
  }

  const rules = new Map();
  const body = matrixMatch[1];
  const objectPattern = /\{\s*name:\s*'([^']+)',([\s\S]*?)\n\s*\},?/g;
  let match;

  while ((match = objectPattern.exec(body)) !== null) {
    const [, name, fields] = match;
    const always = /\balways:\s*true\b/.test(fields);
    const patternsMatch = fields.match(/patterns:\s*\[([\s\S]*?)\]/);
    const patterns = patternsMatch
      ? [...patternsMatch[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
      : [];

    if (!always && patterns.length === 0) {
      throw new Error(`${name}: gate rule has neither always=true nor patterns`);
    }
    if (always && patterns.length > 0) {
      throw new Error(`${name}: gate rule cannot combine always=true with patterns`);
    }
    if (rules.has(name)) {
      throw new Error(`${name}: duplicate gate rule`);
    }
    rules.set(name, { always, patterns });
  }

  if (rules.size === 0) {
    throw new Error('Required CI gate matrix did not contain any workflow rules');
  }
  return rules;
}

export function extractPullRequestPaths(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const pullRequestIndex = lines.findIndex((line) => /^  pull_request:\s*$/.test(line));
  if (pullRequestIndex < 0) {
    throw new Error('Workflow is missing a top-level pull_request trigger');
  }

  let blockEnd = lines.length;
  for (let index = pullRequestIndex + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*/.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }

  let pathsIndex = -1;
  for (let index = pullRequestIndex + 1; index < blockEnd; index += 1) {
    if (/^    paths:\s*$/.test(lines[index])) {
      pathsIndex = index;
      break;
    }
  }
  if (pathsIndex < 0) return null;

  const paths = [];
  for (let index = pathsIndex + 1; index < blockEnd; index += 1) {
    const line = lines[index];
    const item = line.match(/^      -\s+['"]([^'"]+)['"]\s*$/);
    if (item) {
      paths.push(item[1]);
      continue;
    }
    if (/^\s*$/.test(line) || /^      #/.test(line)) continue;
    if (!/^      /.test(line)) break;
    throw new Error(`Unsupported pull_request.paths syntax: ${line.trim()}`);
  }

  if (paths.length === 0) {
    throw new Error('pull_request.paths exists but no literal path entries were found');
  }
  return paths;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function compareRuleToWorkflow(name, rule, workflowPaths) {
  if (rule.always) {
    if (workflowPaths !== null) {
      return `${name}: gate marks workflow always-required but workflow has pull_request.paths`;
    }
    return null;
  }

  if (workflowPaths === null) {
    return `${name}: gate is path-scoped but workflow runs for every pull request`;
  }

  const gatePaths = sortedUnique(rule.patterns);
  const yamlPaths = sortedUnique(workflowPaths);
  if (gatePaths.length !== rule.patterns.length) {
    return `${name}: gate matrix contains duplicate path entries`;
  }
  if (yamlPaths.length !== workflowPaths.length) {
    return `${name}: workflow pull_request.paths contains duplicate entries`;
  }

  if (JSON.stringify(gatePaths) !== JSON.stringify(yamlPaths)) {
    const onlyGate = gatePaths.filter((item) => !yamlPaths.includes(item));
    const onlyWorkflow = yamlPaths.filter((item) => !gatePaths.includes(item));
    return `${name}: path contract drift (gate-only=${JSON.stringify(onlyGate)}, workflow-only=${JSON.stringify(onlyWorkflow)})`;
  }
  return null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runSelfTests() {
  const fixtureGate = `const WORKFLOW_RULES = [
  {
    name: 'Always',
    always: true,
  },
  {
    name: 'Scoped',
    patterns: [
      'apps/example/**',
      'package.json',
    ],
  },
];`;
  const fixtureAlwaysWorkflow = `name: Always\n\non:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\n`;
  const fixtureScopedWorkflow = `name: Scoped\n\non:\n  pull_request:\n    branches: [main]\n    paths:\n      - 'apps/example/**'\n      - 'package.json'\n  push:\n    branches: [main]\n`;

  const rules = extractGateRules(fixtureGate);
  assert(rules.size === 2, 'gate rule parser should find two rules');
  assert(rules.get('Always')?.always === true, 'always rule should be recognized');
  assert(
    JSON.stringify(rules.get('Scoped')?.patterns) ===
      JSON.stringify(['apps/example/**', 'package.json']),
    'scoped gate paths should be parsed in order',
  );
  assert(
    extractPullRequestPaths(fixtureAlwaysWorkflow) === null,
    'always workflow should have no paths filter',
  );
  assert(
    JSON.stringify(extractPullRequestPaths(fixtureScopedWorkflow)) ===
      JSON.stringify(['apps/example/**', 'package.json']),
    'workflow paths should be parsed',
  );
  assert(
    compareRuleToWorkflow('Always', rules.get('Always'), null) === null,
    'always contract should match',
  );
  assert(
    compareRuleToWorkflow(
      'Scoped',
      rules.get('Scoped'),
      ['apps/example/**', 'package.json'],
    ) === null,
    'scoped contract should match',
  );
  assert(
    compareRuleToWorkflow('Scoped', rules.get('Scoped'), ['package.json'])?.includes(
      'path contract drift',
    ),
    'missing workflow path should be detected',
  );
  assert(
    compareRuleToWorkflow('Always', rules.get('Always'), ['README.md'])?.includes(
      'always-required',
    ),
    'unexpected always-workflow path filter should be detected',
  );
  assert(WORKFLOW_FILES.has('Mobile CI'), 'required workflow registry must include Mobile CI');
  assert(
    WORKFLOW_FILES.get('Mobile CI') === '.github/workflows/mobile-ci.yml',
    'Mobile CI workflow mapping must remain canonical',
  );
  assert(
    WORKFLOW_FILES.has('Nginx Security Policy'),
    'required workflow registry must include Nginx Security Policy',
  );
  assert(
    WORKFLOW_FILES.get('Nginx Security Policy') === '.github/workflows/nginx-security-policy.yml',
    'Nginx Security Policy workflow mapping must remain canonical',
  );

  console.log('Required CI trigger drift guard self-tests passed.');
}

export function runDriftCheck() {
  const gateRules = extractGateRules(readFileSync(GATE_PATH, 'utf8'));
  const failures = [];

  for (const [name, workflowPath] of WORKFLOW_FILES) {
    const rule = gateRules.get(name);
    if (!rule) {
      failures.push(`${name}: missing from Required CI Gate matrix`);
      continue;
    }

    let workflowPaths;
    try {
      workflowPaths = extractPullRequestPaths(readFileSync(workflowPath, 'utf8'));
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      continue;
    }

    const mismatch = compareRuleToWorkflow(name, rule, workflowPaths);
    if (mismatch) failures.push(mismatch);
  }

  for (const name of gateRules.keys()) {
    if (!WORKFLOW_FILES.has(name)) {
      failures.push(`${name}: gate matrix rule has no audited workflow mapping`);
    }
  }

  if (failures.length > 0) {
    console.error('Required CI path-contract drift detected:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Required CI path contracts match ${WORKFLOW_FILES.size} aggregated workflow triggers.`,
  );
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runDriftCheck();
}
