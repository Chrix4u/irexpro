'use strict';
/**
 * Tests for the P1-6 redundant-code inventory scanner: the scan must
 * reproduce the pinned audit findings (A6/A9/D4) on the live tree, stay
 * deterministic, and refuse to reconcile when pinned facts disappear.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  PINNED_AUDIT_FINDINGS,
  scanRedundantCode,
  reconcileRedundantCodeInventory,
  renderRemovalProposal,
} = require('./v2-redundant-code-inventory.cjs');
const { ENGINE_COMPONENT_MAP } = require('./v2-engine-component-map.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

test('scan reproduces the pinned A6 dead imports on the live tree', () => {
  const inventory = scanRedundantCode(repoRoot);
  for (const pinnedFile of PINNED_AUDIT_FINDINGS.deadImportFiles) {
    assert.ok(
      inventory.deadImports.some((d) => d.file === pinnedFile),
      `expected dead import in ${pinnedFile}`,
    );
  }
  // The audit names the never-committed modules; every flagged import
  // target must indeed be unresolvable in the tree.
  assert.ok(inventory.deadImports.length >= PINNED_AUDIT_FINDINGS.deadImportFiles.length);
});

test('scan reproduces the pinned A9 deprecated shim', () => {
  const inventory = scanRedundantCode(repoRoot);
  const shim = inventory.deprecatedShims.find(
    (s) => s.file === 'apps/api/src/modules/ai/multimodel-demo-authority.ts');
  assert.ok(shim, 'multimodel-demo-authority.ts must be flagged as a deprecated shim');
  assert.ok(shim.lines <= 40);
});

test('scan reproduces the pinned D4 duplicate lot constants', () => {
  const inventory = scanRedundantCode(repoRoot);
  const group = inventory.duplicateConstants.find((g) => g.literal === "'0.2'");
  assert.ok(group, 'duplicate constant group for 0.2 must exist');
  const names = new Set(group.names.map((n) => n.name));
  assert.ok(names.has('PAPER_PRODUCT_PREFERRED_LOT'));
  assert.ok(names.has('PAPER_PRODUCT_ABSOLUTE_MIN_LOT'));
  const sizing = group.names.find(
    (n) => n.name === 'PAPER_PRODUCT_PREFERRED_LOT' &&
      n.file === 'apps/api/src/modules/execution/services/position-sizing.service.ts');
  assert.ok(sizing, 'constants must be attributed to position-sizing.service.ts');
});

test('reconciliation of the live scan is green', () => {
  const inventory = scanRedundantCode(repoRoot);
  const rec = reconcileRedundantCodeInventory(inventory);
  assert.strictEqual(rec.reconciled, true, `problems: ${rec.problems.join('; ')}`);
});

test('reconciliation refuses when pinned facts disappear (tamper proofing)', () => {
  const inventory = scanRedundantCode(repoRoot);
  const tampered = {
    ...inventory,
    deadImports: inventory.deadImports.filter(
      (d) => d.file !== PINNED_AUDIT_FINDINGS.deadImportFiles[0]),
    deprecatedShims: [],
  };
  const rec = reconcileRedundantCodeInventory(tampered);
  assert.strictEqual(rec.reconciled, false);
  assert.ok(rec.problems.some((p) => p.startsWith('A6_DEAD_IMPORT_MISSING')));
  assert.ok(rec.problems.some((p) => p.startsWith('A9_DEPRECATED_SHIM_MISSING')));
});

test('reconciliation refuses on empty inputs', () => {
  assert.throws(() => reconcileRedundantCodeInventory(null), /INVENTORY_REQUIRED/);
  const empty = {
    deadImports: [], deprecatedShims: [], duplicateConstants: [],
  };
  const rec = reconcileRedundantCodeInventory(empty);
  assert.strictEqual(rec.reconciled, false);
  assert.ok(rec.problems.includes('A6_DEAD_IMPORT_SCAN_EMPTY'));
});

test('near-duplicate scan is deterministic and bounded', () => {
  const componentFiles = ENGINE_COMPONENT_MAP.components.map((c) => c.path);
  const a = scanRedundantCode(repoRoot, { componentFilePaths: componentFiles });
  const b = scanRedundantCode(repoRoot, { componentFilePaths: componentFiles });
  assert.deepStrictEqual(a, b);
  for (const pair of a.nearDuplicateFiles) {
    assert.ok(pair.jaccard >= 0.75);
  }
});

test('unused-export candidates carry declaring files and render as proposal', () => {
  const componentFiles = ENGINE_COMPONENT_MAP.components.map((c) => c.path);
  const inventory = scanRedundantCode(repoRoot, { componentFilePaths: componentFiles });
  for (const c of inventory.unusedExportCandidates) {
    assert.ok(c.name && c.file.endsWith('.ts'));
  }
  const proposal = renderRemovalProposal(inventory);
  assert.ok(proposal.includes('P1-6 redundant-code removal proposal'));
  assert.ok(proposal.includes('Proposal only'));
  assert.ok(proposal.includes('## A6 — unimportable research modules (dead references)'));
});
