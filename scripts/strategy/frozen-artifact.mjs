import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_CHECKS = [
  'balancedAccuracy',
  'sharpeRatio',
  'profitFactor',
  'maxDrawdown',
  'positiveWindowFraction',
  'positiveInstrumentFraction',
  'confidence',
  'evidence',
  'frequency',
  'evidenceCohortIntegrity',
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function artifactDigest(artifact) {
  const { artifactDigest: ignored, ...unsigned } = artifact;
  void ignored;
  return 'sha256:' + sha256Buffer(Buffer.from(JSON.stringify(canonical(unsigned))));
}

function assertQualified(descriptor) {
  if (descriptor.strategyFrozen !== true) {
    throw new Error('strategyFrozen must be true');
  }
  if (descriptor.qualification?.demoReviewEligible !== true) {
    throw new Error('qualification.demoReviewEligible must be true');
  }
  for (const check of REQUIRED_CHECKS) {
    if (descriptor.qualification?.checks?.[check] !== true) {
      throw new Error(`qualification check failed or missing: ${check}`);
    }
  }
  if (!/^[0-9a-f]{40}$/i.test(String(descriptor.sourceCommit ?? ''))) {
    throw new Error('sourceCommit must be a full 40-character git SHA');
  }
  if (!String(descriptor.modelVersion ?? '').trim()) throw new Error('modelVersion is required');
  if (!String(descriptor.evidenceCohortKey ?? '').trim()) {
    throw new Error('evidenceCohortKey is required');
  }
}

function hashSourceFiles(repoRoot, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('files must be non-empty');
  return files.map((relativePath) => {
    const normalized = String(relativePath).replaceAll('\\\\', '/');
    if (normalized.startsWith('/') || normalized.includes('../')) {
      throw new Error(`unsafe source path: ${relativePath}`);
    }
    const absolute = path.join(repoRoot, normalized);
    const content = fs.readFileSync(absolute);
    return { path: normalized, sha256: sha256Buffer(content) };
  });
}

function freeze(repoRoot, descriptorPath, outputPath) {
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  assertQualified(descriptor);
  const artifact = {
    schemaVersion: 1,
    ...descriptor,
    sourceFiles: hashSourceFiles(repoRoot, descriptor.files),
  };
  delete artifact.files;
  artifact.artifactDigest = artifactDigest(artifact);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(canonical(artifact), null, 2) + '\n');
  console.log(`Frozen strategy artifact: ${outputPath}`);
  console.log(`Digest: ${artifact.artifactDigest}`);
}

function verifyArtifact(repoRoot, artifactPath) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assertQualified(artifact);
  if (artifact.schemaVersion !== 1) throw new Error('unsupported schemaVersion');
  const expectedDigest = artifactDigest(artifact);
  if (artifact.artifactDigest !== expectedDigest) {
    throw new Error(`artifact digest mismatch: ${artifactPath}`);
  }
  for (const source of artifact.sourceFiles ?? []) {
    const absolute = path.join(repoRoot, source.path);
    const actual = sha256Buffer(fs.readFileSync(absolute));
    if (actual !== source.sha256) {
      throw new Error(`frozen source changed: ${source.path}`);
    }
  }
  console.log(`Verified frozen artifact ${path.basename(artifactPath)} ${expectedDigest}`);
}
function verifyAll(repoRoot) {
  const dir = path.join(repoRoot, 'strategy-artifacts');
  if (!fs.existsSync(dir)) return console.log('No strategy-artifacts directory; nothing frozen.');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.artifact.json')).sort();
  if (files.length === 0) return console.log('No frozen strategy artifacts yet.');
  for (const name of files) verifyArtifact(repoRoot, path.join(dir, name));
}

function selfTest() {
  const a = { b: 2, a: { d: 4, c: 3 } };
  const b = { a: { c: 3, d: 4 }, b: 2 };
  const digestA = 'sha256:' + sha256Buffer(Buffer.from(JSON.stringify(canonical(a))));
  const digestB = 'sha256:' + sha256Buffer(Buffer.from(JSON.stringify(canonical(b))));
  if (digestA !== digestB) throw new Error('canonical hashing is not deterministic');
  let failed = false;
  try {
    assertQualified({ strategyFrozen: false });
  } catch {
    failed = true;
  }
  if (!failed) throw new Error('qualification guard self-test failed');
  console.log('Frozen strategy artifact self-tests passed.');
}

const repoRoot = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
if (args[0] === '--self-test') selfTest();
else if (args[0] === '--freeze') {
  if (!args[1] || !args[2]) throw new Error('usage: --freeze <descriptor.json> <output.artifact.json>');
  freeze(repoRoot, path.resolve(args[1]), path.resolve(args[2]));
} else if (args[0] === '--verify-one') {
  if (!args[1]) throw new Error('usage: --verify-one <artifact.json>');
  verifyArtifact(repoRoot, path.resolve(args[1]));
} else verifyAll(repoRoot);
