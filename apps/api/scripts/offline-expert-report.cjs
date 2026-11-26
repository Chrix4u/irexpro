'use strict';

// Reads a bounded, locally supplied research dataset. Never connects to services.
const fs = require('node:fs');
const { evaluateExpertEvidence } = require('./offline-expert-evaluator.cjs');
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

function run(argv, output = process.stdout, errors = process.stderr) {
  if (argv.length !== 1 || argv[0] === '--help') {
    errors.write('Usage: node offline-expert-report.cjs <local-research-dataset.json>\n');
    return argv.length === 1 && argv[0] === '--help' ? 0 : 2;
  }
  let fd;
  try {
    fd = fs.openSync(argv[0], 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
      throw new Error('Expected a regular JSON file of at most 32 MiB');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) break;
      offset += n;
    }
    if (offset !== stat.size) throw new Error('Dataset changed while being read');
    const input = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
    const report = evaluateExpertEvidence(input);
    output.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  } catch (error) {
    // Do not echo input, paths or potentially identifying parser excerpts.
    errors.write('Research report rejected: invalid, unavailable or inconsistent dataset.\n');
    return 1;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));
module.exports = { run };
