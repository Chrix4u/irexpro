'use strict';
/**
 * V2 redundant-code inventory (P1-6). Mechanical inventory of the audit's
 * dead-reference categories over the repo, computed on demand and
 * reconciled against the pinned audit findings (A6, A9, D4):
 *
 *   A6 — unimportable research modules (python imports that resolve to no
 *        committed file);
 *   A9 — deprecated re-export-only shims still on the import graph;
 *   D4 — the same literal constant maintained under multiple exported
 *        names (e.g. lot preference '0.2');
 *   plus token-level near-duplicate file pairs over the component map's
 *   path-verified file set, and unused-export candidates.
 *
 * Proposal only: this module never deletes or edits anything. The removal
 * list it renders is staged for a separately reviewable cleanup PR.
 */

const fs = require('node:fs');
const path = require('node:path');

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Pinned audit findings the scan must reproduce (A6 dead imports, the A9
 * shim, the D4 duplicate constant group). Anything pinned that the scan
 * no longer finds is a reconciliation failure; new findings beyond the
 * pinned set are recorded as extras (candidates, not removal verdicts).
 */
const PINNED_AUDIT_FINDINGS = Object.freeze({
  deadImportFiles: Object.freeze([
    'services/ai-engine/app/domain/training/six_pair_v74_quote_profitability_router.py',
    'services/ai-engine/app/domain/training/six_pair_v74_micro_ev_router.py',
    'services/ai-engine/app/domain/training/six_pair_v75_quote_sleeve_router.py',
    'services/ai-engine/app/domain/training/six_pair_v75_pair_specialists.py',
    'services/ai-engine/app/domain/training/bounded_final_campaign.py',
  ]),
  deprecatedShims: Object.freeze([
    'apps/api/src/modules/ai/multimodel-demo-authority.ts',
  ]),
  duplicateConstantValue: "'0.2'",
  duplicateConstantNames: Object.freeze([
    'PAPER_PRODUCT_PREFERRED_LOT',
    'PAPER_PRODUCT_ABSOLUTE_MIN_LOT',
  ]),
  duplicateConstantFile: 'apps/api/src/modules/execution/services/position-sizing.service.ts',
});

/** Walk a directory recursively for files matching a suffix set. */
function walkFiles(rootDir, suffixes) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (suffixes.some((s) => entry.name.endsWith(s))) out.push(full);
    }
  }
  return out;
}

/** A6: python files whose `app.*` or relative imports resolve to nothing
 * directly, or resolve only to files that are themselves dead (transitive). */
function scanDeadPythonImports(repoRoot) {
  const pyRoot = path.join(repoRoot, 'services/ai-engine');
  const files = walkFiles(pyRoot, ['.py']);
  const relOf = (file) => path.relative(repoRoot, file);
  const direct = new Map(); // file rel -> Set(dead module strings)
  const moduleToFile = new Map(); // module string -> file rel (resolvable)
  for (const file of files) {
    const rel = relOf(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const fromMatch = line.match(/^\s*from\s+((?:app|\.)[\w.]*)\s+import\s+/);
      const importMatch = line.match(/^\s*import\s+((?:app|\.)[\w.]*)\s*(?:$|as\s)/);
      const module = fromMatch ? fromMatch[1] : importMatch ? importMatch[1] : null;
      if (module === null) continue;
      let resolved;
      if (module.startsWith('.')) {
        const levels = module.match(/^\.+/)[0].length;
        let base = path.dirname(file);
        for (let i = 1; i < levels; i += 1) base = path.dirname(base);
        const rest = module.slice(levels).replace(/\./g, path.sep);
        resolved = rest === '' ? base : path.join(base, rest);
      } else {
        resolved = path.join(repoRoot, 'services/ai-engine', module.replace(/\./g, path.sep));
      }
      const pyPath = `${resolved}.py`;
      if (fs.existsSync(pyPath)) {
        moduleToFile.set(module, relOf(pyPath));
      } else if (!fs.existsSync(resolved)) {
        if (!direct.has(rel)) direct.set(rel, new Set());
        direct.get(rel).add(module);
      }
    }
  }
  // Transitive closure: importing a module that resolves to a dead file
  // makes the importer unimportable too (v75 specialists -> dead v74
  // router). Fixed-point iteration.
  const deadFiles = new Set([...direct.keys()]);
  const transitive = new Map(); // file rel -> Set(dead file it imports)
  for (let pass = 0; pass < 10; pass += 1) {
    let changed = false;
    for (const file of files) {
      const rel = relOf(file);
      if (deadFiles.has(rel)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        const fromMatch = line.match(/^\s*from\s+((?:app|\.)[\w.]*)\s+import\s+/);
        const importMatch = line.match(/^\s*import\s+((?:app|\.)[\w.]*)\s*(?:$|as\s)/);
        const module = fromMatch ? fromMatch[1] : importMatch ? importMatch[1] : null;
        if (module === null) continue;
        const target = moduleToFile.get(module);
        if (target !== undefined && deadFiles.has(target)) {
          deadFiles.add(rel);
          if (!transitive.has(rel)) transitive.set(rel, new Set());
          transitive.get(rel).add(target);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const dead = [];
  for (const [rel, modules] of direct) {
    for (const module of modules) {
      dead.push({ file: rel, import: module, via: null });
    }
  }
  for (const [rel, via] of transitive) {
    for (const target of via) {
      dead.push({ file: rel, import: target, via: 'TRANSITIVE' });
    }
  }
  dead.sort((a, b) => a.file.localeCompare(b.file) || a.import.localeCompare(b.import));
  return dead;
}

/** A9: deprecated re-export-only shims (no own declarations of weight). */
function scanDeprecatedShims(repoRoot, aiDir) {
  const files = walkFiles(aiDir, ['.ts']).filter((f) => !f.endsWith('.spec.ts'));
  const shims = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('@deprecated')) continue;
    const hasExportFrom = /export\s+(?:\*|\{|\btype\b)[\s\S]*?from\s+/.test(text);
    const hasSubstantialDeclaration =
      /\b(?:function\s+\w+|class\s+\w+\s*(?:extends|implements|\{)|interface\s+\w+\s*\{|\benum\s+\w+)/.test(text);
    const lines = text.split('\n').length;
    if (hasExportFrom && !hasSubstantialDeclaration && lines <= 40) {
      shims.push({ file: path.relative(repoRoot, file), lines });
    }
  }
  shims.sort((a, b) => a.file.localeCompare(b.file));
  return shims;
}

/** D4: identical literal constants under multiple exported names. */
function scanDuplicateExportedConstants(repoRoot, scanDirs) {
  const files = [];
  for (const dir of scanDirs) {
    files.push(...walkFiles(dir, ['.ts']).filter((f) => !f.endsWith('.spec.ts')));
  }
  const byLiteral = new Map();
  const literalOfName = new Map(); // `${file}::${name}` -> literal
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, 'utf8');
    const re = /export\s+const\s+(\w+)\s*=\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?)\s*;/g;
    let match = re.exec(text);
    while (match !== null) {
      const literal = match[2].replace(/^"|"$/g, "'");
      const name = match[1];
      literalOfName.set(`${rel}::${name}`, literal);
      if (!byLiteral.has(literal)) byLiteral.set(literal, []);
      byLiteral.get(literal).push({ name, file: rel });
      match = re.exec(text);
    }
  }
  // Aliases: `export const X = OTHER_CONST;` inherit OTHER's literal, so
  // D4 alias chains join the same duplicate group.
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, 'utf8');
    const aliasRe = /export\s+const\s+(\w+)\s*=\s*(\w+)\s*;/g;
    let m = aliasRe.exec(text);
    while (m !== null) {
      const literal = literalOfName.get(`${rel}::${m[2]}`);
      if (literal !== undefined) {
        byLiteral.get(literal).push({ name: m[1], file: rel, aliasOf: m[2] });
      }
      m = aliasRe.exec(text);
    }
  }
  const groups = [];
  for (const [literal, names] of byLiteral) {
    const distinct = [...new Set(names.map((n) => n.name))];
    if (distinct.length >= 2) {
      groups.push({
        literal,
        names: names.slice().sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }
  groups.sort((a, b) => b.names.length - a.names.length || a.literal.localeCompare(b.literal));
  return groups;
}

/** Identifier/number token stream of a file (comments/strings normalized). */
function tokenizeIdentifiers(text) {
  const tokens = [];
  const re = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?/g;
  let m = re.exec(text);
  while (m !== null) {
    tokens.push(m[0]);
    m = re.exec(text);
  }
  return tokens;
}

function multisetJaccard(a, b) {
  const counts = new Map();
  for (const t of a) counts.set(t, (counts.get(t) || 0) + 1);
  let intersection = 0;
  let union = a.length + b.length;
  for (const t of b) {
    const c = counts.get(t) || 0;
    if (c > 0) {
      intersection += 1;
      counts.set(t, c - 1);
    } else {
      union += 0; // already counted in a's length for union purposes
    }
  }
  // proper multiset union = |a| + |b| - intersection
  union = a.length + b.length - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/** Token-level near-duplicate pairs among the component map's files. */
function scanNearDuplicateFiles(repoRoot, componentFilePaths, threshold = 0.75) {
  const unique = [...new Set(componentFilePaths)].sort();
  const tokens = new Map();
  for (const rel of unique) {
    const abs = path.join(repoRoot, rel);
    try {
      const text = fs.readFileSync(abs, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
      tokens.set(rel, tokenizeIdentifiers(text));
    } catch {
      tokens.set(rel, []);
    }
  }
  const pairs = [];
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const a = unique[i];
      const b = unique[j];
      const score = multisetJaccard(tokens.get(a), tokens.get(b));
      if (score >= threshold) {
        pairs.push({ a, b, jaccard: Math.round(score * 1000) / 1000 });
      }
    }
  }
  pairs.sort((x, y) => y.jaccard - x.jaccard || x.a.localeCompare(y.a));
  return pairs;
}

/** Exported symbols never referenced by any other production file. */
function scanUnusedExportCandidates(repoRoot, scanDirs) {
  const files = [];
  for (const dir of scanDirs) {
    files.push(...walkFiles(dir, ['.ts']).filter((f) => !f.endsWith('.spec.ts')));
  }
  const exported = new Map(); // name -> declaring file
  const fileTexts = files.map((f) => fs.readFileSync(f, 'utf8'));
  files.forEach((file, idx) => {
    const rel = path.relative(repoRoot, file);
    const text = fileTexts[idx];
    const re = /export\s+(?:const|function|class|abstract\s+class)\s+(\w+)/g;
    let m = re.exec(text);
    while (m !== null) {
      if (!exported.has(m[1])) exported.set(m[1], rel);
      m = re.exec(text);
    }
  });
  // Reference check: identifier token occurrences in files OTHER than any
  // declaring file (coarse: includes strings/comments — a candidate, not a
  // verdict; every candidate requires manual review before removal).
  const used = new Set();
  files.forEach((file, idx) => {
    const rel = path.relative(repoRoot, file);
    const tokens = new Set(tokenizeIdentifiers(fileTexts[idx]));
    for (const [name, declFile] of exported) {
      if (rel !== declFile && tokens.has(name)) used.add(name);
    }
  });
  const unused = [];
  for (const [name, declFile] of exported) {
    if (!used.has(name)) unused.push({ name, file: declFile });
  }
  unused.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  return unused;
}

/** Full inventory scan. Deterministic: output is fully sorted. */
function scanRedundantCode(repoRoot, options) {
  if (!nonEmptyString(repoRoot)) {
    throw new Error('INVENTORY_REPO_ROOT_REQUIRED');
  }
  const opts = options || {};
  const aiDir = path.join(repoRoot, 'apps/api/src/modules/ai');
  const execDir = path.join(repoRoot, 'apps/api/src/modules/execution');
  const deadImports = scanDeadPythonImports(repoRoot);
  const deprecatedShims = scanDeprecatedShims(repoRoot, aiDir);
  const duplicateConstants = scanDuplicateExportedConstants(repoRoot, [aiDir, execDir]);
  let nearDuplicateFiles = [];
  if (opts.componentFilePaths && Array.isArray(opts.componentFilePaths)) {
    nearDuplicateFiles = scanNearDuplicateFiles(repoRoot, opts.componentFilePaths,
      opts.nearDuplicateThreshold === undefined ? 0.75 : opts.nearDuplicateThreshold);
  }
  const unusedExportCandidates = scanUnusedExportCandidates(repoRoot, [aiDir, execDir]);
  return Object.freeze({
    artifact: 'v2-redundant-code-inventory-v1',
    scannedAt: 'computed-on-demand',
    deadImports: Object.freeze(deadImports),
    deprecatedShims: Object.freeze(deprecatedShims),
    duplicateConstants: Object.freeze(duplicateConstants),
    nearDuplicateFiles: Object.freeze(nearDuplicateFiles),
    unusedExportCandidates: Object.freeze(unusedExportCandidates),
  });
}

/**
 * Reconcile the computed inventory against the pinned audit findings.
 * Missing pinned facts are reconciliation failures; the rest are extras
 * (candidates, never silent removals).
 */
function reconcileRedundantCodeInventory(inventory) {
  if (!inventory || typeof inventory !== 'object') {
    throw new Error('INVENTORY_REQUIRED');
  }
  const problems = [];
  for (const pinnedFile of PINNED_AUDIT_FINDINGS.deadImportFiles) {
    if (!inventory.deadImports.some((d) => d.file === pinnedFile)) {
      problems.push(`A6_DEAD_IMPORT_MISSING:${pinnedFile}`);
    }
  }
  if (inventory.deadImports.length === 0) {
    problems.push('A6_DEAD_IMPORT_SCAN_EMPTY');
  }
  for (const pinnedShim of PINNED_AUDIT_FINDINGS.deprecatedShims) {
    if (!inventory.deprecatedShims.some((s) => s.file === pinnedShim)) {
      problems.push(`A9_DEPRECATED_SHIM_MISSING:${pinnedShim}`);
    }
  }
  const d4 = inventory.duplicateConstants.find(
    (g) => g.literal === PINNED_AUDIT_FINDINGS.duplicateConstantValue);
  if (!d4) {
    problems.push('D4_DUPLICATE_CONSTANT_GROUP_MISSING');
  } else {
    const names = new Set(d4.names.map((n) => n.name));
    for (const pinnedName of PINNED_AUDIT_FINDINGS.duplicateConstantNames) {
      if (!names.has(pinnedName)) {
        problems.push(`D4_CONSTANT_NAME_MISSING:${pinnedName}`);
      }
    }
    if (!d4.names.some((n) => n.name === PINNED_AUDIT_FINDINGS.duplicateConstantNames[0] &&
        n.file === PINNED_AUDIT_FINDINGS.duplicateConstantFile)) {
      problems.push('D4_CONSTANT_FILE_MISMATCH');
    }
  }
  return Object.freeze({
    reconciled: problems.length === 0,
    problems: Object.freeze(problems),
    extras: Object.freeze({
      deadImports: inventory.deadImports.length - PINNED_AUDIT_FINDINGS.deadImportFiles.length,
      note: 'Extras are new mechanical candidates recorded for manual review; ' +
        'the inventory is a proposal only and nothing is removed by this module.',
    }),
  });
}

/** Render the removal-list proposal (markdown) for the cleanup PR. */
function renderRemovalProposal(inventory) {
  const lines = [];
  lines.push('# P1-6 redundant-code removal proposal (research artifact)');
  lines.push('');
  lines.push('Proposal only — staged for a separately reviewable cleanup PR.');
  lines.push('Nothing below is removed by the V2 research branch.');
  lines.push('');
  lines.push('## A6 — unimportable research modules (dead references)');
  for (const d of inventory.deadImports) {
    lines.push(`- \`${d.file}\` imports missing \`${d.import}\``);
  }
  lines.push('');
  lines.push('## A9 — deprecated re-export-only shims');
  for (const s of inventory.deprecatedShims) {
    lines.push(`- \`${s.file}\` (${s.lines} lines)`);
  }
  lines.push('');
  lines.push('## D4 — duplicate exported constants');
  for (const g of inventory.duplicateConstants.slice(0, 20)) {
    lines.push(`- literal ${g.literal}: ${g.names.map((n) => `${n.name} (${n.file})`).join(', ')}`);
  }
  lines.push('');
  if (inventory.nearDuplicateFiles.length > 0) {
    lines.push('## Near-duplicate file pairs (token Jaccard >= threshold)');
    for (const p of inventory.nearDuplicateFiles.slice(0, 20)) {
      lines.push(`- ${p.a} <-> ${p.b} (jaccard ${p.jaccard})`);
    }
    lines.push('');
  }
  lines.push(`## Unused-export candidates: ${inventory.unusedExportCandidates.length} (manual review required)`);
  return lines.join('\n');
}

module.exports = {
  PINNED_AUDIT_FINDINGS,
  scanRedundantCode,
  reconcileRedundantCodeInventory,
  renderRemovalProposal,
};
