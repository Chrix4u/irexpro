'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadApiClient(fakeFetch) {
  const sourcePath = path.resolve(__dirname, '../src/index.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });

  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(errors.length, 0, 'api-client source must transpile without syntax errors');

  const moduleRecord = { exports: {} };
  const unexpectedRequire = (specifier) => {
    throw new Error(`Unexpected runtime import while testing api-client: ${specifier}`);
  };
  const evaluate = new Function(
    'module',
    'exports',
    'require',
    'fetch',
    result.outputText,
  );
  evaluate(moduleRecord, moduleRecord.exports, unexpectedRequire, fakeFetch);
  return moduleRecord.exports;
}

async function testMfaSetupPasswordContract() {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        secret: 'fixture-secret-not-a-real-credential',
        otpauthUri: 'otpauth://totp/fixture',
      }),
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  assert.equal(typeof createApiClient, 'function');

  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const fixturePassword = 'fixture-current-password';
  await client.beginMfaSetup(fixturePassword);

  assert.equal(calls.length, 1, 'MFA setup must issue exactly one request');
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.example.test/api/v1/auth/mfa/setup');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { password: fixturePassword });
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testChangePasswordContract() {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: 'Password changed successfully' }),
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  await client.changePassword({
    currentPassword: 'fixture-current-password',
    newPassword: 'fixture-new-password-42',
  });

  assert.equal(calls.length, 1, 'change-password must issue exactly one request');
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.example.test/api/v1/auth/change-password');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), {
    currentPassword: 'fixture-current-password',
    newPassword: 'fixture-new-password-42',
  });
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testRevokeOtherSessionsContract() {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        accessToken: 'fixture-rotated-access-token',
        refreshToken: 'fixture-rotated-refresh-token',
      }),
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const tokens = await client.revokeOtherSessions();
  assert.deepEqual(tokens, {
    accessToken: 'fixture-rotated-access-token',
    refreshToken: 'fixture-rotated-refresh-token',
  });

  assert.equal(calls.length, 1, 'revoke-others must issue exactly one request');
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.example.test/api/v1/auth/sessions/revoke-others');
  assert.equal(init.method, 'POST');
  // No-body POST convention (mirrors logout): no body property is set at all.
  assert.equal(init.body, undefined);
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testListSecurityEventsContract() {
  const scenarios = [
    {
      label: 'both params provided',
      args: { limit: 20, offset: 40 },
      expectedPath: '/auth/security-events?limit=20&offset=40',
    },
    {
      label: 'no args (server defaults, no query string)',
      args: undefined,
      expectedPath: '/auth/security-events',
    },
    {
      label: 'limit only (absent param omitted entirely)',
      args: { limit: 5 },
      expectedPath: '/auth/security-events?limit=5',
    },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          events: [
            {
              id: 'fixture-event-id',
              action: 'USER_PASSWORD_CHANGED',
              createdAt: '2025-01-01T00:00:00.000Z',
              severity: 'INFO',
            },
          ],
          hasMore: false,
        }),
      };
    };

    const { createApiClient } = loadApiClient(fakeFetch);
    const client = createApiClient({
      baseUrl: 'https://api.example.test/api/v1',
      getAccessToken: () => 'fixture-access-token',
    });

    await client.listSecurityEvents(scenario.args);

    assert.equal(
      calls.length,
      1,
      `security-events (${scenario.label}) must issue exactly one request`,
    );
    const [{ url, init }] = calls;
    assert.equal(
      url,
      `https://api.example.test/api/v1${scenario.expectedPath}`,
      `security-events (${scenario.label}) URL`,
    );
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
}

async function testUpdateMyProfileContract() {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ id: 'fixture-user-id' }),
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const profileUpdate = {
    firstName: 'Fixture',
    lastName: 'User',
    dateOfBirth: '1990-06-15',
    countryCode: 'US',
  };
  await client.updateMyProfile(profileUpdate);

  assert.equal(calls.length, 1, 'update-my-profile must issue exactly one request');
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.example.test/api/v1/users/me');
  assert.equal(init.method, 'PATCH');
  assert.deepEqual(JSON.parse(init.body), profileUpdate);
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testChangePasswordErrorContract() {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({
      statusCode: 401,
      message: 'Current password verification failed',
    }),
  });

  const { createApiClient, ApiClientError } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  await assert.rejects(
    client.changePassword({
      currentPassword: 'fixture-current-password',
      newPassword: 'fixture-new-password-42',
    }),
    (error) => {
      assert.ok(error instanceof ApiClientError, 'error must be an ApiClientError');
      assert.equal(error.statusCode, 401);
      assert.equal(error.message, 'Current password verification failed');
      assert.deepEqual(error.raw, {
        statusCode: 401,
        message: 'Current password verification failed',
      });
      return true;
    },
  );
}

async function testRevokeOtherSessionsNetworkErrorContract() {
  const fakeFetch = async () => {
    throw new Error('fixture network failure');
  };

  const { createApiClient, ApiClientError } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  await assert.rejects(
    client.revokeOtherSessions(),
    (error) => {
      assert.ok(error instanceof ApiClientError, 'error must be an ApiClientError');
      assert.equal(error.statusCode, 0);
      assert.equal(
        error.message,
        'Network error contacting API: fixture network failure',
      );
      return true;
    },
  );
}

async function main() {
  await testMfaSetupPasswordContract();
  console.log('api-client MFA setup contract test passed.');
  await testChangePasswordContract();
  console.log('api-client change-password contract test passed.');
  await testRevokeOtherSessionsContract();
  console.log('api-client revoke-others contract test passed.');
  await testListSecurityEventsContract();
  console.log('api-client security-events contract test passed.');
  await testUpdateMyProfileContract();
  console.log('api-client update-my-profile contract test passed.');
  await testChangePasswordErrorContract();
  console.log('api-client change-password failure contract test passed.');
  await testRevokeOtherSessionsNetworkErrorContract();
  console.log('api-client revoke-others network-failure contract test passed.');
}

main().catch((error) => {
  console.error(`api-client contract test failed: ${error.message}`);
  process.exit(1);
});
