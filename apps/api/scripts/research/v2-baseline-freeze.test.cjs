'use strict';
/**
 * Tests for the V2-G1 immutable baseline freeze (PI-0). Verifies the pinned
 * generation artifacts are byte-intact, the freeze record is stable, and
 * tampering with the manifest comparison is a typed refusal.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  BASELINE_GENERATION,
  BASELINE_FILES,
  FROZEN_MANIFEST,
  computeBaselineManifest,
  compareManifests,
  verifyBaselineIntegrity,
  baselineFingerprint,
} = require('./v2-baseline-freeze.cjs');

test('V2-G1 baseline is intact: every pinned artifact matches the frozen hash', () => {
  const manifest = verifyBaselineIntegrity();
  assert.strictEqual(manifest.entries.length, BASELINE_FILES.length);
  assert.strictEqual(manifest.generation.generationId, 'V2-G1');
  assert.strictEqual(manifest.generation.freezeCommit, '559d4d06d8a6fa8b35e27b2e1058f9bd5ae7d638');
  for (const entry of manifest.entries) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.bytes > 0);
  }
});

test('freeze record: six pinned runnable artifacts, generation identity frozen', () => {
  assert.strictEqual(BASELINE_FILES.length, 6);
  assert.strictEqual(FROZEN_MANIFEST.length, BASELINE_FILES.length);
  const pinned = new Set(BASELINE_FILES);
  for (const e of FROZEN_MANIFEST) assert.ok(pinned.has(e.path));
  // The E-10 results artifact carries the recorded campaign SHA-256 prefix.
  const e10 = FROZEN_MANIFEST.find((e) => e.path.endsWith('e10-results.json'));
  assert.strictEqual(e10.sha256.slice(0, 16), '50c7ef8b97205ca8');
  // The frozen commit is the exact E-10 review head.
  assert.strictEqual(BASELINE_GENERATION.freezeCommit.length, 40);
  assert.strictEqual(BASELINE_GENERATION.frozenAt, '2026-11-28');
  assert.ok(BASELINE_GENERATION.description.includes('honest negative'));
});

test('baseline fingerprint is a stable deterministic generation id', () => {
  const a = baselineFingerprint();
  const b = baselineFingerprint();
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('compareManifests detects hash mismatch and unpinned artifacts', () => {
  const current = computeBaselineManifest();
  const first = current.entries[0];
  const tamperedHash = '0'.repeat(64);
  const frozenBad = [{ path: first.path, sha256: tamperedHash }];
  const r1 = compareManifests(current, frozenBad);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.mismatches.filter((m) => m.kind === 'HASH_MISMATCH').length, 1);
  assert.strictEqual(r1.mismatches.filter((m) => m.kind === 'UNPINNED').length, current.entries.length - 1);

  const frozenSubset = [FROZEN_MANIFEST[0]];
  const r2 = compareManifests(current, frozenSubset);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.mismatches.every((m) => m.kind === 'UNPINNED'));
});

test('compareManifests refuses malformed input, never guesses', () => {
  assert.throws(() => compareManifests(null, FROZEN_MANIFEST), /BASELINE_MANIFEST_REQUIRED/);
  assert.throws(() => compareManifests({}, FROZEN_MANIFEST), /BASELINE_MANIFEST_REQUIRED/);
  assert.throws(() => compareManifests({ entries: [] }, null), /BASELINE_MANIFEST_REQUIRED/);
});

test('tamper propagation: a drifted pinned artifact surfaces as BASELINE_TAMPERED', () => {
  const current = computeBaselineManifest();
  const frozenBad = current.entries.map((e, i) => ({
    path: e.path,
    sha256: i === 0 ? 'f'.repeat(64) : e.sha256,
  }));
  const r = compareManifests(current, frozenBad);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.mismatches.length, 1);
  assert.strictEqual(r.mismatches[0].kind, 'HASH_MISMATCH');
  assert.match(r.mismatches[0].detail, /frozen f+… vs current/);
});

test('manifest completeness: exact match against the frozen manifest is ok', () => {
  const current = computeBaselineManifest();
  const frozenLike = current.entries.map((e) => ({ path: e.path, sha256: e.sha256 }));
  const r = compareManifests(current, frozenLike);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mismatches.length, 0);
});
