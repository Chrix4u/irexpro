import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIRECTORY = '.github/workflows';
const SHA256_DIGEST = /@sha256:[0-9a-f]{64}$/i;

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

function normalizeYamlScalar(raw) {
  // Image references cannot legitimately contain a whitespace-delimited YAML
  // comment. Keep embedded whitespace (notably `${{ ... }}` expressions) so
  // the policy can reject expressions rather than silently ignoring the line.
  return stripMatchingQuotes(raw.replace(/\s+#.*$/, '').trim());
}

function imageReferenceFromLine(line) {
  const serviceImage = line.match(/^\s*image:\s*(.+?)\s*$/);
  if (serviceImage) return normalizeYamlScalar(serviceImage[1]);

  // Shell-driven helper containers must use an explicitly named env variable
  // so the immutable image reference remains visible to this policy check.
  const containerImageEnv = line.match(
    /^\s*[A-Z][A-Z0-9_]*_CONTAINER_IMAGE:\s*(.+?)\s*$/,
  );
  if (containerImageEnv) return normalizeYamlScalar(containerImageEnv[1]);

  return null;
}

export function auditWorkflowContainerDigests(workflowName, source) {
  const failures = [];
  let imageCount = 0;

  for (const line of source.replaceAll('\r\n', '\n').split('\n')) {
    const reference = imageReferenceFromLine(line);
    if (!reference) continue;

    imageCount += 1;
    if (reference.includes('${{')) {
      failures.push(
        `${workflowName}: expression-based container image references are forbidden (${reference})`,
      );
      continue;
    }

    if (!SHA256_DIGEST.test(reference)) {
      failures.push(
        `${workflowName}: container image must be pinned with @sha256:<64-hex-digest> (${reference})`,
      );
    }
  }

  return { failures, imageCount };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runSelfTests() {
  const digest = 'a'.repeat(64);

  const pinnedService = auditWorkflowContainerDigests(
    'pinned-service.yml',
    `services:\n  postgres:\n    image: postgres:16-bookworm@sha256:${digest}\n`,
  );
  assert(
    pinnedService.failures.length === 0 && pinnedService.imageCount === 1,
    `pinned service image should pass: ${pinnedService.failures}`,
  );

  const pinnedServiceWithComment = auditWorkflowContainerDigests(
    'pinned-service-comment.yml',
    `services:\n  postgres:\n    image: postgres:16-bookworm@sha256:${digest} # Docker Official Image\n`,
  );
  assert(
    pinnedServiceWithComment.failures.length === 0 &&
      pinnedServiceWithComment.imageCount === 1,
    `pinned service image with comment should pass: ${pinnedServiceWithComment.failures}`,
  );

  const mutableService = auditWorkflowContainerDigests(
    'mutable-service.yml',
    'services:\n  postgres:\n    image: postgres:16-bookworm\n',
  );
  assert(
    mutableService.failures.some((failure) => failure.includes('@sha256')),
    'tag-only service image must fail',
  );

  const pinnedHelper = auditWorkflowContainerDigests(
    'pinned-helper.yml',
    `env:\n  POSTGRES_CONTAINER_IMAGE: postgres:16-bookworm@sha256:${digest}\n`,
  );
  assert(
    pinnedHelper.failures.length === 0 && pinnedHelper.imageCount === 1,
    `pinned helper container image should pass: ${pinnedHelper.failures}`,
  );

  const mutableHelper = auditWorkflowContainerDigests(
    'mutable-helper.yml',
    'env:\n  POSTGRES_CONTAINER_IMAGE: postgres:16-bookworm\n',
  );
  assert(
    mutableHelper.failures.some((failure) => failure.includes('@sha256')),
    'tag-only helper container image must fail',
  );

  const shortDigest = auditWorkflowContainerDigests(
    'short-digest.yml',
    'services:\n  postgres:\n    image: postgres:16-bookworm@sha256:abc123\n',
  );
  assert(
    shortDigest.failures.some((failure) => failure.includes('64-hex-digest')),
    'short container digest must fail',
  );

  const expression = auditWorkflowContainerDigests(
    'expression.yml',
    'services:\n  postgres:\n    image: ${{ env.POSTGRES_IMAGE }}\n',
  );
  assert(
    expression.failures.some((failure) => failure.includes('expression-based')),
    'expression-based service image must fail',
  );

  const expressionWithComment = auditWorkflowContainerDigests(
    'expression-comment.yml',
    'services:\n  postgres:\n    image: ${{ env.POSTGRES_IMAGE }} # dynamic image\n',
  );
  assert(
    expressionWithComment.failures.some((failure) => failure.includes('expression-based')),
    'expression-based service image with comment must fail',
  );

  console.log('Workflow container-digest policy self-tests passed.');
}

export function runPolicyCheck() {
  const workflowFiles = readdirSync(WORKFLOW_DIRECTORY)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  if (workflowFiles.length === 0) {
    throw new Error('No GitHub Actions workflow files were found');
  }

  const failures = [];
  let imageCount = 0;
  for (const workflowFile of workflowFiles) {
    const result = auditWorkflowContainerDigests(
      workflowFile,
      readFileSync(join(WORKFLOW_DIRECTORY, workflowFile), 'utf8'),
    );
    failures.push(...result.failures);
    imageCount += result.imageCount;
  }

  if (failures.length > 0) {
    console.error('Workflow container-digest policy failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Workflow container-digest policy passed for ${workflowFiles.length} workflows and ${imageCount} container image references.`,
  );
}

if (process.argv.includes('--self-test')) {
  runSelfTests();
} else if (import.meta.url === `file://${process.argv[1]}`) {
  runPolicyCheck();
}
