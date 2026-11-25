'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./offline-expert-report.cjs');
function fixture(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-research-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.json');
  fs.writeFileSync(file, body);
  return file;
}
function invoke(args) {
  let out = '', err = '';
  const code = run(args, { write: s => { out += s; } }, { write: s => { err += s; } });
  return { code, out, err };
}
test('emits aggregate JSON and leaves the source dataset unchanged', t => {
  const body = JSON.stringify({ horizonSeconds: 300, observations: [] });
  const file = fixture(t, body);
  const result = invoke([file]);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  const report = JSON.parse(result.out);
  assert.equal(report.resolved, 0);
  assert.equal(report.modifiesExecution, false);
  assert.equal(fs.readFileSync(file, 'utf8'), body);
});
test('rejects invalid JSON without disclosing private input', t => {
  const result = invoke([fixture(t, 'PRIVATE-EXAMPLE malformed JSON')]);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.ok(!result.err.includes('PRIVATE-EXAMPLE'));
});
test('rejects wrong shape, missing arguments and directories', t => {
  const file = fixture(t, JSON.stringify({ horizonSeconds: 300 }));
  assert.equal(invoke([file]).code, 1);
  assert.equal(invoke([path.dirname(file)]).code, 1);
  assert.equal(invoke([]).code, 2);
  assert.equal(invoke(['--help']).code, 0);
});
