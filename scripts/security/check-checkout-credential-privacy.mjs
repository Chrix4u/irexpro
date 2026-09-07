import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIRECTORY = '.github/workflows';
const LOCAL_ACTION_DIRECTORY = '.github/actions';
const CHECKOUT_REFERENCE = /^actions\/checkout@[0-9a-f]{40}$/i;

function indentation(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function stripMatchingQuotes(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function valueWithoutComment(value) {
  return value.split(/\s+#/, 1)[0].trim();
}

function checkoutReference(line) {
  const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/);
  if (!match) return null;
  const reference = stripMatchingQuotes(match[1]);
  return CHECKOUT_REFERENCE.test(reference) ? reference : null;
}

function findStepStart(lines, usesIndex) {
  const usesLine = lines[usesIndex];
  if (/^\s*-\s*uses:/.test(usesLine)) {
    return { index: usesIndex, indent: indentation(usesLine) };
  }

  const usesIndent = indentation(usesLine);
  for (let index = usesIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndent = indentation(line);
    if (lineIndent >= usesIndent) continue;
    if (/^\s*-\s+/.test(line)) return { index, indent: lineIndent };
    break;
  }
  return null;
}

function findStepEnd(lines, stepStart, usesIndex) {
  for (let index = usesIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndent = indentation(line);
    if (lineIndent < stepStart.indent) return index;
    if (lineIndent === stepStart.indent && /^\s*-\s+/.test(line)) return index;
  }
  return lines.length;
}

export function auditCheckoutCredentialPrivacy(sourceName, source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const failures = [];
  let checkoutCount = 0;

  for (let usesIndex = 0; usesIndex < lines.length; usesIndex += 1) {
    if (!checkoutReference(lines[usesIndex])) continue;
    checkoutCount += 1;

    const stepStart = findStepStart(lines, usesIndex);
    if (!stepStart) {
      failures.push(`${sourceName}: could not determine actions/checkout step boundary`);
      continue;
    }
    const stepEnd = findStepEnd(lines, stepStart, usesIndex);

    let withIndent = null;
    const credentialValues = [];
    for (let index = usesIndex + 1; index < stepEnd; index += 1) {
      const line = lines[index];
      const withMatch = line.match(/^\s*with:\s*(?:#.*)?$/);
      if (withMatch) {
        withIndent = indentation(line);
        continue;
      }

      const credentialMatch = line.match(/^\s*persist-credentials:\s*(.*?)\s*$/i);
      if (!credentialMatch) continue;
      const lineIndent = indentation(line);
      if (withIndent === null || lineIndent <= withIndent) {
        failures.push(
          `${sourceName}: actions/checkout persist-credentials must be nested under with:`,
        );
        continue;
      }
      credentialValues.push(
        stripMatchingQuotes(valueWithoutComment(credentialMatch[1])).toLowerCase(),
      );
    }

    if (credentialValues.length === 0) {
      failures.push(
        `${sourceName}: actions/checkout must explicitly set persist-credentials: false`,
      );
      continue;
    }
    if (credentialValues.length !== 1) {
      failures.push(
        `${sourceName}: actions/checkout must define persist-credentials exactly once`,
      );
      continue;
    }
    if (credentialValues[0] !== 'false') {
      failures.push(
        `${sourceName}: actions/checkout persist-credentials must be the literal false`,
      );
    }
  }

  return { failures, checkoutCount };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function workflowFixture(checkoutBody) {
  return `name: Fixture\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Checkout\n        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09\n${checkoutBody}\n      - name: Test\n        run: echo ok\n`;
}

export function runSelfTests() {
  const safe = auditCheckoutCredentialPrivacy(
    'safe.yml',
    workflowFixture('        with:\n          persist-credentials: false'),
  );
  assert(safe.failures.length === 0, `safe fixture failed: ${safe.failures}`);
  assert(safe.checkoutCount === 1, 'safe fixture should find one checkout');

  const quotedFalse = auditCheckoutCredentialPrivacy(
    'quoted.yml',
    workflowFixture("        with:\n          persist-credentials: 'false'"),
  );
  assert(quotedFalse.failures.length === 0, 'quoted literal false should pass');

  const omitted = auditCheckoutCredentialPrivacy('omitted.yml', workflowFixture(''));
  assert(
    omitted.failures.some((failure) => failure.includes('explicitly set')),
    'omitted persist-credentials must fail',
  );

  const enabled = auditCheckoutCredentialPrivacy(
    'enabled.yml',
    workflowFixture('        with:\n          persist-credentials: true'),
  );
  assert(
    enabled.failures.some((failure) => failure.includes('literal false')),
    'persist-credentials=true must fail',
  );

  const expression = auditCheckoutCredentialPrivacy(
    'expression.yml',
    workflowFixture(
      "        with:\n          persist-credentials: ${{ github.event_name == 'push' }}",
    ),
  );
  assert(
    expression.failures.some((failure) => failure.includes('literal false')),
    'expression-based persist-credentials must fail',
  );

  const wrongScope = auditCheckoutCredentialPrivacy(
    'wrong-scope.yml',
    workflowFixture('        env:\n          persist-credentials: false'),
  );
  assert(
    wrongScope.failures.some((failure) => failure.includes('nested under with:')),
    'persist-credentials outside with: must fail',
  );

  const inlineStep = auditCheckoutCredentialPrivacy(
    'inline.yml',
    `jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09\n        with:\n          persist-credentials: false\n      - run: echo ok\n`,
  );
  assert(inlineStep.failures.length === 0, 'inline checkout step should pass');

  console.log('Checkout credential-privacy self-tests passed.');
}

function listWorkflowFiles() {
  if (!existsSync(WORKFLOW_DIRECTORY)) return [];
  return readdirSync(WORKFLOW_DIRECTORY)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => join(WORKFLOW_DIRECTORY, name))
    .sort();
}

function listLocalActionManifests(directory = LOCAL_ACTION_DIRECTORY) {
  if (!existsSync(directory)) return [];
  const manifests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...listLocalActionManifests(path));
    } else if (entry.isFile() && (entry.name === 'action.yml' || entry.name === 'action.yaml')) {
      manifests.push(path);
    }
  }
  return manifests.sort();
}

export function runPolicyCheck() {
  const sources = [...listWorkflowFiles(), ...listLocalActionManifests()];
  if (sources.length === 0) throw new Error('No workflow or local action manifests found');

  const failures = [];
  let checkoutCount = 0;
  for (const sourceName of sources) {
    const result = auditCheckoutCredentialPrivacy(sourceName, readFileSync(sourceName, 'utf8'));
    failures.push(...result.failures);
    checkoutCount += result.checkoutCount;
  }

  if (failures.length > 0) {
    console.error('Checkout credential-privacy policy failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Checkout credential-privacy policy passed for ${checkoutCount} checkout steps across ${sources.length} workflow/action files.`,
  );
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runPolicyCheck();
}
