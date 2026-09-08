import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('JWT algorithm policy wiring', () => {
  const authModuleSource = readFileSync(resolve(__dirname, 'auth.module.ts'), 'utf8');
  const jwtStrategySource = readFileSync(
    resolve(__dirname, 'strategies', 'jwt.strategy.ts'),
    'utf8',
  );
  const realtimeModuleSource = readFileSync(
    resolve(__dirname, '..', 'realtime', 'realtime.module.ts'),
    'utf8',
  );
  const wsJwtGuardSource = readFileSync(
    resolve(__dirname, '..', 'realtime', 'guards', 'ws-jwt.guard.ts'),
    'utf8',
  );
  const envExample = readFileSync(resolve(__dirname, '..', '..', '..', '.env.example'), 'utf8');

  it('pins Nest JWT signing and verification to HS256', () => {
    expect(authModuleSource).toContain("algorithm: 'HS256'");
    expect(authModuleSource).toContain("verifyOptions: { algorithms: ['HS256'] }");
  });

  it('pins Passport bearer verification to HS256', () => {
    expect(jwtStrategySource).toContain("algorithms: ['HS256']");
  });

  it('pins realtime module and WebSocket guard verification to HS256', () => {
    expect(realtimeModuleSource).toContain("verifyOptions: { algorithms: ['HS256'] }");
    expect(wsJwtGuardSource).toContain("algorithms: ['HS256']");
  });

  it('keeps deployment guidance aligned with the implemented symmetric-key runtime', () => {
    expect(envExample).toContain('the current runtime signs and verifies HS256 only');
    expect(envExample).not.toContain('JWT_PRIVATE_KEY_PATH');
    expect(envExample).not.toContain('JWT_PUBLIC_KEY_PATH');
    expect(envExample).not.toContain('Use RS256 in production');
  });
});
