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

testMfaSetupPasswordContract()
  .then(() => {
    console.log('api-client MFA setup contract test passed.');
  })
  .catch((error) => {
    console.error(`api-client contract test failed: ${error.message}`);
    process.exit(1);
  });
