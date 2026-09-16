import { readFileSync } from 'fs';
import { join } from 'path';

describe('BrokerService connect-failure audit truth', () => {
  it('uses the mismatch boolean, never the environmentMismatch result object, for mismatch metadata and CRITICAL severity', () => {
    const source = readFileSync(join(__dirname, 'broker.service.ts'), 'utf8');

    // A normal provider failure returns { mismatch: false, observed: ... }.
    // The result object itself is always truthy, so using it as a condition
    // fabricates ACCOUNT_TYPE_MISMATCH metadata and CRITICAL severity.
    expect(source).toContain('...(environmentMismatch.mismatch');
    expect(source).toContain(
      'severity: environmentMismatch.mismatch ? AuditSeverity.CRITICAL : AuditSeverity.WARNING',
    );

    expect(source).not.toMatch(/\.\.\.\(environmentMismatch\s*\?/);
    expect(source).not.toMatch(
      /severity:\s*environmentMismatch\s*\?\s*AuditSeverity\.CRITICAL/,
    );
  });
});
