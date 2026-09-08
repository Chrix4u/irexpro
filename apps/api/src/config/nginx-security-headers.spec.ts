import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('Nginx security policy', () => {
  it('passes the repository security policy checker', () => {
    const repositoryRoot = resolve(__dirname, '../../../..');
    const checker = resolve(repositoryRoot, 'scripts/security/check-nginx-security-headers.mjs');

    const output = execFileSync(process.execPath, [checker], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    expect(output).toContain(
      'Nginx transport-security, API identity, realtime ingress, and server-token policy passed.',
    );
  });
});
