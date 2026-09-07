import { readFileSync } from 'node:fs';
import { WORKFLOW_FILES } from './check-required-ci-trigger-drift.mjs';

const candidateExpression =
  "CANDIDATE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const expectedCheckoutRef = '${{ env.CANDIDATE_SHA }}';
const REQUIRED_GATE_PATH = '.github/workflows/required-ci-gate.yml';
const CHECKOUT_REFERENCE = /^actions\/checkout@[0-9a-f]{40}$/i;

export function criticalWorkflowPaths() {
  return [...new Set([...WORKFLOW_FILES.values(), REQUIRED_GATE_PATH])];
}

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

function findStepEnd(lines, stepStart, fromIndex) {
  for (let index = fromIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndent = indentation(line);
    if (lineIndent < stepStart.indent) return index;
    if (lineIndent === stepStart.indent && /^\s*-\s+/.test(line)) return index;
  }
  return lines.length;
}

function findNextStepStart(lines, currentStepEnd, stepIndent) {
  for (let index = currentStepEnd; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndent = indentation(line);
    if (lineIndent < stepIndent) return null;
    if (lineIndent === stepIndent && /^\s*-\s+/.test(line)) {
      return { index, indent: stepIndent };
    }
  }
  return null;
}

function checkoutRefValues(lines, usesIndex, stepEnd) {
  let withIndent = null;
  const values = [];

  for (let index = usesIndex + 1; index < stepEnd; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndent = indentation(line);

    if (/^\s*with:\s*(?:#.*)?$/.test(line)) {
      withIndent = lineIndent;
      continue;
    }
    if (withIndent !== null && lineIndent <= withIndent) {
      withIndent = null;
    }

    const refMatch = line.match(/^\s*ref:\s*(.*?)\s*$/);
    if (!refMatch || withIndent === null || lineIndent <= withIndent) continue;
    values.push(stripMatchingQuotes(valueWithoutComment(refMatch[1])));
  }

  return values;
}

function isComparisonCommand(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('test ') || trimmed.startsWith('[[ ') || trimmed.startsWith('[ ');
}

function hasHeadCandidateComparison(effectiveLines) {
  const direct = effectiveLines.some((line) => {
    const trimmed = line.trim();
    return (
      isComparisonCommand(trimmed) &&
      trimmed.includes('git rev-parse HEAD') &&
      trimmed.includes('CANDIDATE_SHA')
    );
  });
  if (direct) return true;

  for (const line of effectiveLines) {
    const trimmed = line.trim();
    const assignment = trimmed.match(
      /^([A-Za-z_][A-Za-z0-9_]*)=(?:["'])?\$\(git rev-parse HEAD\)(?:["'])?$/,
    );
    if (!assignment) continue;
    const variable = assignment[1];
    const variableReferences = [`$${variable}`, `\${${variable}}`];
    const compared = effectiveLines.some((candidateLine) => {
      const candidate = candidateLine.trim();
      return (
        isComparisonCommand(candidate) &&
        candidate.includes('CANDIDATE_SHA') &&
        variableReferences.some((reference) => candidate.includes(reference))
      );
    });
    if (compared) return true;
  }
  return false;
}

function verificationFailure(lines, checkoutStepEnd, checkoutStepIndent) {
  const nextStep = findNextStepStart(lines, checkoutStepEnd, checkoutStepIndent);
  if (!nextStep) return 'checkout is not immediately followed by an exact-head verification step';
  const nextStepEnd = findStepEnd(lines, nextStep, nextStep.index);
  const block = lines.slice(nextStep.index, nextStepEnd);
  const effectiveLines = block.filter(
    (line) => line.trim() && !line.trimStart().startsWith('#'),
  );

  if (effectiveLines.some((line) => /^\s*if:\s*/.test(line))) {
    return 'exact-head verification step must be unconditional';
  }
  if (
    effectiveLines.some((line) =>
      /^\s*continue-on-error:\s*true\s*(?:#.*)?$/i.test(line),
    )
  ) {
    return 'exact-head verification step must fail closed';
  }
  if (!effectiveLines.some((line) => /^\s*run:\s*(?:\||>|\S)/.test(line))) {
    return 'checkout is not immediately followed by a runnable verification step';
  }
  if (!hasHeadCandidateComparison(effectiveLines)) {
    return 'verification step must compare git rev-parse HEAD with CANDIDATE_SHA';
  }
  return null;
}

export function auditWorkflowProvenance(workflowPath, text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const failures = [];
  const hasTopLevelCandidate = lines.some(
    (line) => indentation(line) === 2 && line.trim() === candidateExpression,
  );
  if (!hasTopLevelCandidate) {
    failures.push(`${workflowPath}: missing immutable top-level candidate SHA expression`);
  }

  let checkoutCount = 0;
  for (let usesIndex = 0; usesIndex < lines.length; usesIndex += 1) {
    if (!checkoutReference(lines[usesIndex])) continue;
    checkoutCount += 1;

    const stepStart = findStepStart(lines, usesIndex);
    if (!stepStart) {
      failures.push(`${workflowPath}: could not determine actions/checkout step boundary`);
      continue;
    }
    const stepEnd = findStepEnd(lines, stepStart, usesIndex);
    const refs = checkoutRefValues(lines, usesIndex, stepEnd);
    if (refs.length !== 1) {
      failures.push(
        `${workflowPath}: checkout step must define exactly one with.ref for CANDIDATE_SHA`,
      );
    } else if (refs[0] !== expectedCheckoutRef) {
      failures.push(
        `${workflowPath}: checkout with.ref must be the literal ${expectedCheckoutRef}`,
      );
    }

    const verification = verificationFailure(lines, stepEnd, stepStart.indent);
    if (verification) failures.push(`${workflowPath}: ${verification}`);
  }

  if (checkoutCount === 0) {
    failures.push(`${workflowPath}: no SHA-pinned actions/checkout step found`);
  }
  return failures;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeFixture() {
  return `name: Fixture\n\non:\n  pull_request:\n\npermissions:\n  contents: read\n\nenv:\n  ${candidateExpression}\n\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Checkout\n        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09\n        with:\n          ref: \${{ env.CANDIDATE_SHA }}\n          persist-credentials: false\n\n      - name: Verify exact candidate checkout\n        shell: bash\n        run: |\n          set -Eeuo pipefail\n          test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"\n\n      - name: Build\n        run: echo ok\n`;
}

export function runSelfTests() {
  const paths = criticalWorkflowPaths();
  assert(
    paths.includes('.github/workflows/mobile-ci.yml'),
    'exact-head provenance set must include Mobile CI',
  );
  assert(
    paths.includes(REQUIRED_GATE_PATH),
    'exact-head provenance set must include Required CI Gate',
  );
  assert(
    paths.length === WORKFLOW_FILES.size + 1,
    'provenance set must contain every aggregated required workflow plus Required CI Gate',
  );

  const good = safeFixture();
  assert(
    auditWorkflowProvenance('good.yml', good).length === 0,
    `safe exact-head fixture should pass: ${auditWorkflowProvenance('good.yml', good)}`,
  );

  const storedHead = good.replace(
    `          test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"`,
    `          actual="$(git rev-parse HEAD)"\n          test "$actual" = "$CANDIDATE_SHA"`,
  );
  assert(
    auditWorkflowProvenance('stored-head.yml', storedHead).length === 0,
    'stored HEAD followed by fail-closed comparison should pass',
  );

  const unusedHead = good.replace(
    `          test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"`,
    `          actual="$(git rev-parse HEAD)"\n          test -n "$CANDIDATE_SHA"`,
  );
  assert(
    auditWorkflowProvenance('unused-head.yml', unusedHead).some((failure) =>
      failure.includes('must compare'),
    ),
    'unused HEAD read must not satisfy provenance verification',
  );

  const wrongRef = good.replace(
    'ref: ${{ env.CANDIDATE_SHA }}',
    'ref: ${{ github.sha }}',
  );
  assert(
    auditWorkflowProvenance('wrong-ref.yml', wrongRef).some((failure) =>
      failure.includes('with.ref must be the literal'),
    ),
    'wrong checkout ref must fail',
  );

  const missingVerification = good.replace(
    `      - name: Verify exact candidate checkout\n        shell: bash\n        run: |\n          set -Eeuo pipefail\n          test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"\n\n`,
    '',
  );
  assert(
    auditWorkflowProvenance('missing-verification.yml', missingVerification).some((failure) =>
      failure.includes('verification step'),
    ),
    'missing verification step must fail',
  );

  const commentSpoof = good.replace(
    `          test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"`,
    `          # test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"\n          echo not-a-verification`,
  );
  assert(
    auditWorkflowProvenance('comment-spoof.yml', commentSpoof).some((failure) =>
      failure.includes('must compare'),
    ),
    'comment-only verification text must fail',
  );

  const conditional = good.replace(
    '      - name: Verify exact candidate checkout\n        shell: bash',
    "      - name: Verify exact candidate checkout\n        if: github.ref == 'refs/heads/main'\n        shell: bash",
  );
  assert(
    auditWorkflowProvenance('conditional.yml', conditional).some((failure) =>
      failure.includes('unconditional'),
    ),
    'conditional verification must fail',
  );

  const twoCheckout = good.replace(
    '      - name: Build\n        run: echo ok',
    `      - name: Second checkout\n        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09\n        with:\n          ref: \${{ github.sha }}\n          persist-credentials: false\n\n      - name: Verify second checkout\n        run: |\n          test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"\n\n      - name: Build\n        run: echo ok`,
  );
  assert(
    auditWorkflowProvenance('two-checkout.yml', twoCheckout).some((failure) =>
      failure.includes('with.ref must be the literal'),
    ),
    'each checkout must be validated independently',
  );

  console.log(
    `Exact-head provenance self-tests passed for ${paths.length} critical workflow mappings.`,
  );
}

export function runPolicyCheck() {
  const failures = [];
  const criticalWorkflows = criticalWorkflowPaths();

  for (const workflowPath of criticalWorkflows) {
    failures.push(
      ...auditWorkflowProvenance(workflowPath, readFileSync(workflowPath, 'utf8')),
    );
  }

  if (failures.length > 0) {
    console.error('Exact-head workflow provenance policy failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Exact-head workflow provenance policy passed for ${criticalWorkflows.length} workflows.`,
  );
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runSelfTests();
  runPolicyCheck();
}
