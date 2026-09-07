import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIRECTORY = '.github/workflows';
const LOCAL_ACTION_DIRECTORY = '.github/actions';
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const ALLOWED_WRITE_PERMISSIONS = new Set(['security-events']);
const FLOATING_GITHUB_RUNNER = /^(?:ubuntu|windows|macos)-latest$/i;

function stripMatchingQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function actionReferenceFromLine(line) {
  const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/);
  if (!match) return null;
  return stripMatchingQuotes(match[1]);
}

function runnerLabelFromLine(line) {
  const match = line.match(/^\s*runs-on:\s*([^\s#]+)(?:\s+#.*)?$/);
  if (!match) return null;
  return stripMatchingQuotes(match[1]);
}

function isLocalReference(reference) {
  return reference.startsWith('./');
}

function validateExternalActionReference(reference) {
  if (reference.startsWith('docker://')) {
    return 'docker:// action references are not permitted by this policy';
  }

  const separator = reference.lastIndexOf('@');
  if (separator <= 0 || separator === reference.length - 1) {
    return 'external action reference must include @<40-character commit SHA>';
  }

  const source = reference.slice(0, separator);
  const revision = reference.slice(separator + 1);
  if (source.includes('${{') || revision.includes('${{')) {
    return 'expression-based external action references are not permitted';
  }
  if (!source.includes('/')) {
    return 'external action source must identify an owner/repository path';
  }
  if (!FULL_COMMIT_SHA.test(revision)) {
    return `external action revision must be an exact 40-character commit SHA, got ${revision}`;
  }
  return null;
}

function auditActionReferences(sourceName, lines) {
  const failures = [];
  let externalActionCount = 0;

  for (const line of lines) {
    const reference = actionReferenceFromLine(line);
    if (!reference) continue;

    if (isLocalReference(reference)) {
      if (reference.includes('${{')) {
        failures.push(
          `${sourceName}: expression-based local action references are not permitted (${reference})`,
        );
      }
      continue;
    }

    externalActionCount += 1;
    const referenceFailure = validateExternalActionReference(reference);
    if (referenceFailure) {
      failures.push(`${sourceName}: ${referenceFailure} (${reference})`);
    }
  }

  return { failures, externalActionCount };
}

export function auditWorkflowText(workflowName, source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const failures = [];

  if (lines.some((line) => /^\s*pull_request_target:\s*$/.test(line))) {
    failures.push(`${workflowName}: pull_request_target is forbidden`);
  }

  if (
    lines.some((line) =>
      /^\s*persist-credentials:\s*true\s*(?:#.*)?$/i.test(line),
    )
  ) {
    failures.push(`${workflowName}: persist-credentials=true is forbidden`);
  }

  const explicitTopLevelPermissions = lines.some((line) => /^permissions:\s*$/.test(line));
  if (!explicitTopLevelPermissions) {
    failures.push(`${workflowName}: missing explicit top-level permissions block`);
  }

  if (lines.some((line) => /^permissions:\s*write-all\s*(?:#.*)?$/i.test(line))) {
    failures.push(`${workflowName}: permissions: write-all is forbidden`);
  }

  for (const line of lines) {
    const permission = line.match(/^\s+([A-Za-z0-9-]+):\s*write\s*(?:#.*)?$/i);
    if (permission && !ALLOWED_WRITE_PERMISSIONS.has(permission[1])) {
      failures.push(
        `${workflowName}: unapproved token write permission ${permission[1]}: write`,
      );
    }

    const runnerLabel = runnerLabelFromLine(line);
    if (runnerLabel && FLOATING_GITHUB_RUNNER.test(runnerLabel)) {
      failures.push(
        `${workflowName}: floating GitHub-hosted runner label ${runnerLabel} is forbidden; pin an explicit runner image`,
      );
    }
  }

  const referenceAudit = auditActionReferences(workflowName, lines);
  failures.push(...referenceAudit.failures);

  return { failures, externalActionCount: referenceAudit.externalActionCount };
}

export function auditLocalActionText(actionName, source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  return auditActionReferences(actionName, lines);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function goodWorkflow(extra = '') {
  return `name: Fixture\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n${extra}\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09\n        with:\n          persist-credentials: false\n`;
}

function goodCompositeAction(reference = 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444') {
  return `name: Composite Fixture\ndescription: Test fixture\nruns:\n  using: composite\n  steps:\n    - uses: ${reference}\n`;
}

export function runSelfTests() {
  const clean = auditWorkflowText('clean.yml', goodWorkflow());
  assert(clean.failures.length === 0, `clean fixture failed: ${clean.failures}`);
  assert(clean.externalActionCount === 1, 'clean fixture should find one external action');

  const floatingRunner = auditWorkflowText(
    'floating-runner.yml',
    goodWorkflow().replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest'),
  );
  assert(
    floatingRunner.failures.some((failure) => failure.includes('floating GitHub-hosted runner')),
    'floating GitHub-hosted runner labels must fail',
  );

  const tagged = auditWorkflowText(
    'tagged.yml',
    goodWorkflow().replace(
      'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
      'actions/checkout@v5',
    ),
  );
  assert(
    tagged.failures.some((failure) => failure.includes('40-character commit SHA')),
    'mutable action tags must fail',
  );

  const shortSha = auditWorkflowText(
    'short.yml',
    goodWorkflow().replace(
      'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
      'actions/checkout@fbc6f3992d24',
    ),
  );
  assert(
    shortSha.failures.some((failure) => failure.includes('40-character commit SHA')),
    'short action SHAs must fail',
  );

  const dangerousTrigger = auditWorkflowText(
    'target.yml',
    goodWorkflow().replace('  pull_request:', '  pull_request_target:'),
  );
  assert(
    dangerousTrigger.failures.some((failure) => failure.includes('pull_request_target')),
    'pull_request_target must fail',
  );

  const persistedCredentials = auditWorkflowText(
    'credentials.yml',
    goodWorkflow().replace('persist-credentials: false', 'persist-credentials: true'),
  );
  assert(
    persistedCredentials.failures.some((failure) =>
      failure.includes('persist-credentials=true'),
    ),
    'persisted checkout credentials must fail',
  );

  const missingPermissions = auditWorkflowText(
    'missing-permissions.yml',
    goodWorkflow().replace('permissions:\n  contents: read\n', ''),
  );
  assert(
    missingPermissions.failures.some((failure) => failure.includes('top-level permissions')),
    'missing top-level permissions must fail',
  );

  const writeAll = auditWorkflowText(
    'write-all.yml',
    goodWorkflow().replace('permissions:\n  contents: read', 'permissions: write-all'),
  );
  assert(
    writeAll.failures.some((failure) => failure.includes('write-all')),
    'write-all must fail',
  );

  const broadWrite = auditWorkflowText(
    'contents-write.yml',
    goodWorkflow().replace('contents: read', 'contents: write'),
  );
  assert(
    broadWrite.failures.some((failure) => failure.includes('contents: write')),
    'unapproved write permission must fail',
  );

  const codeqlWrite = auditWorkflowText(
    'codeql.yml',
    goodWorkflow('  security-events: write\n'),
  );
  assert(
    codeqlWrite.failures.length === 0,
    `approved CodeQL write permission should pass: ${codeqlWrite.failures}`,
  );

  const localAction = auditWorkflowText(
    'local.yml',
    goodWorkflow().replace(
      'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
      './.github/actions/local-check',
    ),
  );
  assert(localAction.failures.length === 0, 'local workflow actions should be allowed');
  assert(localAction.externalActionCount === 0, 'local actions are not external actions');

  const cleanComposite = auditLocalActionText('action.yml', goodCompositeAction());
  assert(
    cleanComposite.failures.length === 0,
    `clean composite action failed: ${cleanComposite.failures}`,
  );
  assert(
    cleanComposite.externalActionCount === 1,
    'clean composite action should find one external action',
  );

  const taggedComposite = auditLocalActionText(
    'tagged-action.yml',
    goodCompositeAction('actions/setup-node@v5'),
  );
  assert(
    taggedComposite.failures.some((failure) => failure.includes('40-character commit SHA')),
    'mutable action tags inside local composite actions must fail',
  );

  const shortComposite = auditLocalActionText(
    'short-action.yml',
    goodCompositeAction('actions/setup-node@a0853c245446'),
  );
  assert(
    shortComposite.failures.some((failure) => failure.includes('40-character commit SHA')),
    'short action SHAs inside local composite actions must fail',
  );

  const nestedLocalComposite = auditLocalActionText(
    'nested-local-action.yml',
    goodCompositeAction('./.github/actions/another-local-action'),
  );
  assert(
    nestedLocalComposite.failures.length === 0,
    'local-to-local composite action references should be allowed',
  );
  assert(
    nestedLocalComposite.externalActionCount === 0,
    'local-to-local action references are not external actions',
  );

  console.log('GitHub Actions supply-chain policy self-tests passed.');
}

function listLocalActionManifests(directory = LOCAL_ACTION_DIRECTORY) {
  if (!existsSync(directory)) return [];

  const manifests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...listLocalActionManifests(path));
      continue;
    }
    if (entry.isFile() && (entry.name === 'action.yml' || entry.name === 'action.yaml')) {
      manifests.push(path);
    }
  }
  return manifests.sort();
}

export function runPolicyCheck() {
  const workflowFiles = readdirSync(WORKFLOW_DIRECTORY)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  if (workflowFiles.length === 0) {
    throw new Error('No GitHub Actions workflow files were found');
  }

  const failures = [];
  let externalActionCount = 0;

  for (const workflowFile of workflowFiles) {
    const result = auditWorkflowText(
      workflowFile,
      readFileSync(join(WORKFLOW_DIRECTORY, workflowFile), 'utf8'),
    );
    failures.push(...result.failures);
    externalActionCount += result.externalActionCount;
  }

  const localActionManifests = listLocalActionManifests();
  for (const actionManifest of localActionManifests) {
    const result = auditLocalActionText(
      actionManifest,
      readFileSync(actionManifest, 'utf8'),
    );
    failures.push(...result.failures);
    externalActionCount += result.externalActionCount;
  }

  if (failures.length > 0) {
    console.error('GitHub Actions supply-chain policy failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `GitHub Actions supply-chain policy passed for ${workflowFiles.length} workflows, ` +
      `${localActionManifests.length} local action manifests, and ${externalActionCount} external action references.`,
  );
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runPolicyCheck();
}
