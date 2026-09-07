import { readFileSync } from 'node:fs';

const WORKFLOW_PATH = '.github/workflows/release-security.yml';

function extractNodeAuditJob(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const start = normalized.indexOf('\n  node-dependency-audit:\n');
  if (start < 0) throw new Error('Release Security workflow is missing node-dependency-audit job');

  const afterStart = start + 1;
  const nextJob = normalized.indexOf('\n  python-lock-and-audit:\n', afterStart);
  if (nextJob < 0) {
    throw new Error('Release Security workflow node-dependency-audit job boundary is missing');
  }
  return normalized.slice(afterStart, nextJob);
}

export function auditReleaseAuditInstallSafety(source) {
  const job = extractNodeAuditJob(source);
  const installLines = job
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('run: pnpm install '));

  const failures = [];
  if (installLines.length !== 1) {
    failures.push(`expected exactly one pnpm install in node-dependency-audit, found ${installLines.length}`);
    return failures;
  }

  const install = installLines[0];
  if (!install.includes('--frozen-lockfile')) {
    failures.push('node-dependency-audit install must use --frozen-lockfile');
  }
  if (!install.includes('--ignore-scripts')) {
    failures.push('node-dependency-audit install must use --ignore-scripts');
  }

  return failures;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fixture(installLine) {
  return `name: Release Security\n\njobs:\n  tracked-secret-scan:\n    runs-on: ubuntu-24.04\n  node-dependency-audit:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Install\n        ${installLine}\n  python-lock-and-audit:\n    runs-on: ubuntu-24.04\n`;
}

export function runSelfTests() {
  const safe = auditReleaseAuditInstallSafety(
    fixture('run: pnpm install --frozen-lockfile --ignore-scripts'),
  );
  assert(safe.length === 0, `safe fixture failed: ${safe.join('; ')}`);

  const scriptsEnabled = auditReleaseAuditInstallSafety(
    fixture('run: pnpm install --frozen-lockfile'),
  );
  assert(
    scriptsEnabled.some((failure) => failure.includes('--ignore-scripts')),
    'script-enabled install must fail',
  );

  const mutableLock = auditReleaseAuditInstallSafety(
    fixture('run: pnpm install --ignore-scripts'),
  );
  assert(
    mutableLock.some((failure) => failure.includes('--frozen-lockfile')),
    'non-frozen install must fail',
  );

  const duplicate = fixture('run: pnpm install --frozen-lockfile --ignore-scripts').replace(
    '  python-lock-and-audit:',
    '      - name: Extra install\n        run: pnpm install --frozen-lockfile --ignore-scripts\n  python-lock-and-audit:',
  );
  const duplicateFailures = auditReleaseAuditInstallSafety(duplicate);
  assert(
    duplicateFailures.some((failure) => failure.includes('exactly one pnpm install')),
    'multiple installs must fail',
  );

  console.log('Release dependency-audit install-safety self-tests passed.');
}

export function runPolicyCheck() {
  const failures = auditReleaseAuditInstallSafety(readFileSync(WORKFLOW_PATH, 'utf8'));
  if (failures.length > 0) {
    console.error('Release dependency-audit install-safety policy failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('Release dependency-audit install-safety policy passed.');
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runPolicyCheck();
}
