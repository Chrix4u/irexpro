'use strict';
// Local-only diagnostic. Never authenticates, connects to a database, or settles orders.
const fs = require('node:fs');
const { verifyStatementConsistency } = require('../../../packages/types/src/statement-consistency.cjs');

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('ONE_LOCAL_STATEMENT_REQUIRED');
    const file = process.argv[2];
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    let input;
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > 2_000_000) {
        throw new Error('INVALID_STATEMENT_SIZE');
      }
      // Bound the actual read, even if a regular file grows after fstat.
      const buffer = Buffer.alloc(2_000_001);
      let offset = 0;
      while (offset < buffer.length) {
        const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      if (offset > 2_000_000) throw new Error('INVALID_STATEMENT_SIZE');
      input = buffer.subarray(0, offset).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const result = verifyStatementConsistency(input);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'ARITHMETIC_CONSISTENT') process.exitCode = 10;
  } catch {
    console.error('Statement validation failed: unsupported or invalid statement.');
    process.exitCode = 2;
  }
}
module.exports = { verifyStatementConsistency };
