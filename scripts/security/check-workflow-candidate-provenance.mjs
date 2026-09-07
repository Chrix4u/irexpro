import { readFileSync } from 'node:fs';
import { WORKFLOW_FILES } from './check-required-ci-trigger-drift.mjs';

const candidateExpression =
  "CANDIDATE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const checkoutRef = 'ref: ${{ env.CANDIDATE_SHA }}';
const credentialsPolicy = 'persist-credentials: false';
const REQUIRED_GATE_PATH = '.github/workflows/required-ci-gate.yml';

export function criticalWorkflowPaths() {
  return [...new Set([...WORKFLOW_FILES.values(), REQUIRED_GATE_PATH])];
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

export function auditWorkflowProvenance(workflowPath, text) {
  const failures = [];
  const checkoutCount = count(text, 'uses: actions/checkout@');
  const refCount = count(text, checkoutRef);
  const credentialCount = count(text, credentialsPolicy);
  const verificationCount = count(text, 'git rev-parse HEAD');

  if (!text.includes(candidateExpression)) {
    failures.push(`${workflowPath}: missing immutable candidate SHA expression`);
  }
  if (checkoutCount === 0) {
    failures.push(`${workflowPath}: no checkout step found`);
  }
  if (refCount !== checkoutCount) {
    failures.push(
      `${workflowPath}: ${refCount}/${checkoutCount} checkout steps pin env.CANDIDATE_SHA`,
    );
  }
  if (credentialCount !== checkoutCount) {
    failures.push(
      `${workflowPath}: ${credentialCount}/${checkoutCount} checkout steps disable persisted credentials`,
    );
  }
  if (verificationCount !== checkoutCount) {
    failures.push(
      `${workflowPath}: ${verificationCount}/${checkoutCount} checkout steps verify git rev-parse HEAD`,
    );
  }
  return failures;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

  const good = `${candidateExpression}\nuses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09\n${checkoutRef}\n${credentialsPolicy}\ngit rev-parse HEAD\n`;
  assert(
    auditWorkflowProvenance('good.yml', good).length === 0,
    'complete exact-head fixture should pass',
  );

  const missingRef = good.replace(`${checkoutRef}\n`, '');
  assert(
    auditWorkflowProvenance('missing-ref.yml', missingRef).some((failure) =>
      failure.includes('pin env.CANDIDATE_SHA'),
    ),
    'missing checkout ref pin must fail',
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
  runPolicyCheck();
}
