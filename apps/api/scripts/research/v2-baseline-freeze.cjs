'use strict';
/**
 * V2-G1 immutable research baseline freeze (PI-0, directive 2026-11-28).
 *
 * The delivered V2 generation — P1 consolidation plus the E-10 evaluation
 * campaign at commit 559d4d06, with its honest negative after-cost results
 * and its frozen pre-registered challenger preset/policy — is preserved as
 * the immutable research baseline "V2-G1". This contract pins the SHA-256
 * of every core runnable artifact of that generation and refuses drift:
 * later phases (predictive-intelligence research) may ADD artifacts but
 * must never modify the frozen generation in place.
 *
 * Research-only authority; no production runtime changes; no LIVE
 * promotion; the freeze is a research-integrity guard, not a deployment
 * control.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const BASELINE_GENERATION = Object.freeze({
  generationId: 'V2-G1',
  freezeCommit: '559d4d06d8a6fa8b35e27b2e1058f9bd5ae7d638',
  frozenAt: '2026-11-28',
  description: 'V2 generation after P1 consolidation and the E-10 '
    + 'evaluation campaign: honest negative after-cost results (challenger '
    + 'netR negative in every matrix cell), frozen pre-registered challenger '
    + 'preset/policy, no promoted arm, no broker-connected evaluation '
    + 'authority.',
});

/** Pinned core runnable artifacts of V2-G1 (repo-root-relative paths). */
const BASELINE_FILES = Object.freeze([
  'apps/api/scripts/research/v2-intelligence-engine.cjs',
  'apps/api/scripts/research/v2-engine-features.cjs',
  'apps/api/scripts/research/v2-paired-engine-simulator.cjs',
  'apps/api/scripts/research/v2-offline-evaluation-harness.cjs',
  'apps/api/scripts/research/v2-e10-campaign.cjs',
  'runs/v2-e10-campaign-20261128/e10-results.json',
]);

/**
 * Frozen manifest — SHA-256 of each pinned artifact as delivered at
 * 559d4d06. Any in-place modification of a pinned file breaks
 * verifyBaselineIntegrity() (typed refusal BASELINE_TAMPERED).
 */
const FROZEN_MANIFEST = Object.freeze([
  Object.freeze({
    path: 'apps/api/scripts/research/v2-intelligence-engine.cjs',
    sha256: 'ab7c83e0c5758b69db26e226fe15be334ed6dc07a1bdd060117336d9c3055493',
  }),
  Object.freeze({
    path: 'apps/api/scripts/research/v2-engine-features.cjs',
    sha256: 'db43840c3ab6764ff5af0624e056952e765017289423d51a80515f83b7ca2d01',
  }),
  Object.freeze({
    path: 'apps/api/scripts/research/v2-paired-engine-simulator.cjs',
    sha256: 'bc291199dad502608ecd895a6146cd8c22f642d803bf531a77c1b1cf3c6ba68d',
  }),
  Object.freeze({
    path: 'apps/api/scripts/research/v2-offline-evaluation-harness.cjs',
    sha256: 'ecbbce45cac7806d793f90c419da9d4070b4f8786bd2fc94cd4d28fcc1c2fa7c',
  }),
  Object.freeze({
    path: 'apps/api/scripts/research/v2-e10-campaign.cjs',
    sha256: 'd9785e2056ca1b03c9766981b50acf0abe4f3670c4cdc74a62134cca7f71a92e',
  }),
  Object.freeze({
    path: 'runs/v2-e10-campaign-20261128/e10-results.json',
    sha256: '50c7ef8b97205ca882583e632db8e05677a39fb2ba7bd60502f7c6a12f56121b',
  }),
]);

/** Compute the current manifest of the pinned baseline artifacts. */
function computeBaselineManifest() {
  const entries = BASELINE_FILES.map((rel) => {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`BASELINE_FILE_MISSING:${rel}`);
    }
    const buf = fs.readFileSync(abs);
    return Object.freeze({
      path: rel,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    });
  });
  return Object.freeze({
    generation: Object.freeze({ ...BASELINE_GENERATION }),
    entries: Object.freeze(entries),
  });
}

/** Compare a current manifest against a frozen one. Pure; no filesystem. */
function compareManifests(current, frozen) {
  const frozenEntries = Array.isArray(frozen) ? frozen : frozen && frozen.entries;
  if (!current || !Array.isArray(current.entries) || !Array.isArray(frozenEntries)) {
    throw new Error('BASELINE_MANIFEST_REQUIRED');
  }
  const frozenByPath = new Map(frozenEntries.map((e) => [e.path, e.sha256]));
  const mismatches = [];
  for (const entry of current.entries) {
    const frozenHash = frozenByPath.get(entry.path);
    if (frozenHash === undefined) {
      mismatches.push({ path: entry.path, kind: 'UNPINNED', detail: 'artifact not in frozen manifest' });
    } else if (frozenHash !== entry.sha256) {
      mismatches.push({
        path: entry.path,
        kind: 'HASH_MISMATCH',
        detail: `frozen ${frozenHash.slice(0, 16)}… vs current ${entry.sha256.slice(0, 16)}…`,
      });
    }
  }
  return Object.freeze({ ok: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
}

/**
 * Verify the V2-G1 baseline is byte-intact. Returns the verified manifest
 * when intact; throws BASELINE_TAMPERED (with the mismatch inventory) when
 * any pinned artifact drifted. Preserving the immutable baseline is a hard
 * precondition for every later research phase.
 */
function verifyBaselineIntegrity() {
  const current = computeBaselineManifest();
  const comparison = compareManifests(current, { entries: FROZEN_MANIFEST });
  if (!comparison.ok) {
    const detail = comparison.mismatches
      .map((m) => `${m.path}:${m.kind}`).join('; ');
    throw new Error(`BASELINE_TAMPERED:${detail}`);
  }
  return current;
}

/** Stable fingerprint of the frozen generation (hash of canonical JSON). */
function baselineFingerprint() {
  const canonical = JSON.stringify({
    generation: BASELINE_GENERATION,
    entries: FROZEN_MANIFEST.map((e) => ({ path: e.path, sha256: e.sha256 })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  BASELINE_GENERATION,
  BASELINE_FILES,
  FROZEN_MANIFEST,
  computeBaselineManifest,
  compareManifests,
  verifyBaselineIntegrity,
  baselineFingerprint,
};
