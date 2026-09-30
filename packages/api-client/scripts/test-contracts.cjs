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

async function testListAccountAppealsContract() {
  const scenarios = [
    {
      label: 'status and page supplied',
      args: { status: 'PENDING', page: 2, limit: 20 },
      expectedPath: '/admin/account-appeals?status=PENDING&page=2&limit=20',
    },
    {
      label: 'no args lets the server apply defaults',
      args: undefined,
      expectedPath: '/admin/account-appeals',
    },
    {
      label: 'page only omits absent filters',
      args: { page: 3 },
      expectedPath: '/admin/account-appeals?page=3',
    },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const responseBody = {
      items: [],
      page: scenario.args?.page ?? 1,
      limit: scenario.args?.limit ?? 20,
      total: 47,
      totalPages: 3,
    };
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => responseBody,
      };
    };

    const { createApiClient } = loadApiClient(fakeFetch);
    const client = createApiClient({
      baseUrl: 'https://api.example.test/api/v1',
      getAccessToken: () => 'fixture-access-token',
    });

    const result = await client.listAccountAppeals(scenario.args);

    assert.deepEqual(result, responseBody);
    assert.equal(calls.length, 1, `account appeals (${scenario.label}) must issue one request`);
    const [{ url, init }] = calls;
    assert.equal(url, `https://api.example.test/api/v1${scenario.expectedPath}`);
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  }
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

async function testStartBrokerOAuthChannelContract() {
  const scenarios = [
    {
      label: 'mobile channel claims a server callback slot',
      args: ['ctrader', { channel: 'mobile' }],
      expectedBody: { brokerId: 'ctrader', channel: 'mobile' },
    },
    {
      label: 'no options stays source-compatible for web callers',
      args: ['ctrader', undefined],
      expectedBody: { brokerId: 'ctrader' },
    },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const responseBody = {
      authorizationUrl: 'https://id.ctrader.com/oauth/authorize?fixture=1',
      flowId: 'fixture-flow-id',
      expiresAt: '2025-01-01T00:00:00.000Z',
    };
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => responseBody,
      };
    };

    const { createApiClient } = loadApiClient(fakeFetch);
    const client = createApiClient({
      baseUrl: 'https://api.example.test/api/v1',
      getAccessToken: () => 'fixture-access-token',
    });

    const result = await client.startBrokerOAuth(...scenario.args);

    assert.deepEqual(result, responseBody);
    assert.equal(
      calls.length,
      1,
      `oauth authorize (${scenario.label}) must issue exactly one request`,
    );
    const [{ url, init }] = calls;
    assert.equal(url, 'https://api.example.test/api/v1/broker/connections/oauth/authorize');
    assert.equal(init.method, 'POST');
    // Finding 4: the body carries ONLY the broker id + optional channel — a
    // redirect URI (custom app scheme) must NEVER be client-supplied.
    assert.deepEqual(JSON.parse(init.body), scenario.expectedBody);
    assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
}

async function testExchangeBrokerOAuthHandoffContract() {
  const calls = [];
  const responseBody = {
    flowId: 'fixture-flow-id',
    accounts: [
      {
        ctidTraderAccountId: '1234567',
        isLive: false,
        traderLogin: 1234567,
        brokerTitleShort: 'cTrader',
      },
    ],
  };
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => responseBody,
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const result = await client.exchangeBrokerOAuthHandoff({
    handoffToken: 'fixture-one-time-handoff-token',
  });

  assert.deepEqual(result, responseBody);
  assert.equal(calls.length, 1, 'oauth handoff must issue exactly one request');
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.example.test/api/v1/broker/connections/oauth/handoff');
  assert.equal(init.method, 'POST');
  // Finding 4: the ONLY mobile-side secret-ish value is the opaque one-time
  // handoff token — no provider code, access token, or refresh token.
  assert.deepEqual(JSON.parse(init.body), {
    handoffToken: 'fixture-one-time-handoff-token',
  });
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testActiveTradingSessionContract() {
  const calls = [];
  const responseBody = {
    session: {
      id: 'sess_00000000-0000-0000-0000-000000000001',
      brokerConnectionId: 'bconn_00000000-0000-0000-0000-000000000001',
      executionMode: 'SEMI_AUTO',
      authorityGeneration: 3,
      status: 'ACTIVE',
      openingBalance: '10000.00',
      peakEquity: '10250.00',
      startedAt: '2026-09-10T00:00:00.000Z',
    },
  };
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => responseBody,
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const result = await client.getActiveTradingSession();

  // The authoritative session state arrives in the { session } envelope —
  // the client must not unwrap, re-shape, or default it.
  assert.deepEqual(result, responseBody);
  assert.equal(calls.length, 1, 'active session must issue exactly one request');
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.example.test/api/v1/trading/sessions/active');
  assert.equal(init.method ?? 'GET', 'GET');
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testAutomationRuntimeStatusContract() {
  const calls = [];
  const responseBody = {
    enabled: true,
    registered: true,
    trading_session_id: 'sess/needs encoding-1',
    active: true,
    instruments: ['USDJPY'],
    timeframe: 'H1',
    interval_seconds: 10,
    source: 'research_replay',
    last_run_at: '2026-09-30T12:00:00.000Z',
    next_run_at: '2026-09-30T12:00:10.000Z',
    last_decision: 'NO_NEW_MARKET_DATA',
    last_reason: 'market_data_unchanged',
    last_confidence_score: 0.3376,
    last_confidence_at: '2026-09-30T12:00:00.000Z',
    confidence_threshold: 0.6,
    model_version: 'fixture-v10',
    model_mode: 'trained_xgboost_mtf',
    model_loaded: true,
    last_market_data_at: '2026-09-29T19:59:00.000Z',
    last_market_data_close: '143.210',
    market_data_age_seconds: 100,
    market_data_cache_bypassed: false,
    last_publish_failed: false,
    research_uat: true,
    replay_steps_total: 543,
    signals_published_total: 0,
    executions_succeeded_total: 0,
    downstream_rejected_total: 0,
  };
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => responseBody,
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const result = await client.getAutomationRuntimeStatus('sess/needs encoding-1');
  assert.deepEqual(result, responseBody);
  assert.equal(calls.length, 1, 'automation runtime must issue exactly one request');
  const [{ url, init }] = calls;
  assert.equal(
    url,
    'https://api.example.test/api/v1/trading/sessions/sess%2Fneeds%20encoding-1/automation-status',
  );
  assert.equal(init.method ?? 'GET', 'GET');
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testStartTradingSessionContract() {
  const calls = [];
  const responseBody = {
    session: {
      id: 'sess_00000000-0000-0000-0000-000000000002',
      brokerConnectionId: 'bconn_00000000-0000-0000-0000-000000000001',
      executionMode: 'PAPER_ONLY',
      authorityGeneration: 1,
      status: 'ACTIVE',
      openingBalance: null,
      peakEquity: null,
      startedAt: '2026-09-10T00:00:00.000Z',
    },
  };
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 201,
      statusText: 'Created',
      json: async () => responseBody,
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const result = await client.startTradingSession({
    brokerConnectionId: 'bconn_00000000-0000-0000-0000-000000000001',
    executionMode: 'PAPER_ONLY',
  });

  assert.deepEqual(result, responseBody);
  assert.equal(calls.length, 1, 'session start must issue exactly one request');
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.example.test/api/v1/trading/sessions/start');
  assert.equal(init.method, 'POST');
  // The body binds the EXACT connection + durable execution mode — the
  // legacy `requestedMode` shape is gone.
  assert.deepEqual(JSON.parse(init.body), {
    brokerConnectionId: 'bconn_00000000-0000-0000-0000-000000000001',
    executionMode: 'PAPER_ONLY',
  });
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testChangeTradingSessionModeContract() {
  const calls = [];
  const responseBody = {
    session: {
      id: 'sess_00000000-0000-0000-0000-000000000001',
      brokerConnectionId: 'bconn_00000000-0000-0000-0000-000000000001',
      executionMode: 'FULL_AUTO',
      authorityGeneration: 4,
      status: 'ACTIVE',
      openingBalance: '10000.00',
      peakEquity: '10250.00',
      startedAt: '2026-09-10T00:00:00.000Z',
    },
  };
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => responseBody,
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const result = await client.changeTradingSessionMode(
    'sess/needs encoding-1',
    { executionMode: 'FULL_AUTO' },
  );

  assert.deepEqual(result, responseBody);
  assert.equal(calls.length, 1, 'mode change must issue exactly one request');
  const [{ url, init }] = calls;
  // The session id is path-encoded; the body carries ONLY the new mode —
  // the audited generation bump is server-side.
  assert.equal(
    url,
    'https://api.example.test/api/v1/trading/sessions/sess%2Fneeds%20encoding-1/mode',
  );
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { executionMode: 'FULL_AUTO' });
  assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
}

async function testExecutionConfirmationsContract() {
  // ── pending list ──
  {
    const calls = [];
    const responseBody = {
      confirmations: [
        {
          id: 'conf_00000000-0000-0000-0000-000000000001',
          signalId: 'sig_00000000-0000-0000-0000-000000000001',
          instrument: 'EURUSD',
          direction: 'BUY',
          quantity: '0.10',
          stopLoss: '1.09500000',
          takeProfit: '1.11000000',
          expiresAt: '2026-09-10T00:05:00.000Z',
          orderPayloadDigest:
            'sha256:fixture-digest-0000000000000000000000000000000000000000000000000000',
        },
      ],
    };
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => responseBody,
      };
    };

    const { createApiClient } = loadApiClient(fakeFetch);
    const client = createApiClient({
      baseUrl: 'https://api.example.test/api/v1',
      getAccessToken: () => 'fixture-access-token',
    });

    const result = await client.listPendingExecutionConfirmations();

    assert.deepEqual(result, responseBody);
    assert.equal(calls.length, 1, 'pending confirmations must issue exactly one request');
    const [{ url, init }] = calls;
    assert.equal(url, 'https://api.example.test/api/v1/execution/confirmations/pending');
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  }

  // ── confirm: server-consumed authority result ──
  {
    const calls = [];
    const responseBody = { status: 'CONSUMED' };
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => responseBody,
      };
    };

    const { createApiClient } = loadApiClient(fakeFetch);
    const client = createApiClient({
      baseUrl: 'https://api.example.test/api/v1',
      getAccessToken: () => 'fixture-access-token',
    });

    const result = await client.confirmExecutionConfirmation(
      'conf/needs encoding-1',
    );

    // CONSUMED is the ONLY success value — the client never fabricates
    // approval state locally.
    assert.deepEqual(result, responseBody);
    assert.equal(result.status, 'CONSUMED');
    assert.equal(calls.length, 1, 'confirm must issue exactly one request');
    const [{ url, init }] = calls;
    assert.equal(
      url,
      'https://api.example.test/api/v1/execution/confirmations/conf%2Fneeds%20encoding-1/confirm',
    );
    assert.equal(init.method, 'POST');
    // No-body POST convention (mirrors logout/revoke-others).
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
}

async function testConfirmExecutionConfirmation409Contract() {
  // A 409-style typed failure (expired/consumed/revoked/mismatched-generation)
  // must surface as an ApiClientError carrying the server body — the caller
  // renders the server's typed failure, never a local success.
  const fakeFetch = async () => ({
    ok: false,
    status: 409,
    statusText: 'Conflict',
    json: async () => ({
      statusCode: 409,
      message: 'Confirmation expired',
      error: 'Conflict',
    }),
  });

  const { createApiClient, ApiClientError } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  await assert.rejects(
    client.confirmExecutionConfirmation('conf_00000000-0000-0000-0000-000000000001'),
    (error) => {
      assert.ok(error instanceof ApiClientError, 'error must be an ApiClientError');
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, 'Confirmation expired');
      assert.deepEqual(error.raw, {
        statusCode: 409,
        message: 'Confirmation expired',
        error: 'Conflict',
      });
      return true;
    },
  );
}


async function testPositionCloseContracts() {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const isCloseAll = url.endsWith('/execution/positions/close-all');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () =>
        isCloseAll
          ? [{ tradeId: 'trade-1', closed: true, status: 'CLOSED' }]
          : { id: 'trade/needs encoding', status: 'CLOSED' },
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const one = await client.closePosition('trade/needs encoding');
  const all = await client.closeAllAiPositions();

  assert.equal(one.status, 'CLOSED');
  assert.deepEqual(all, [{ tradeId: 'trade-1', closed: true, status: 'CLOSED' }]);
  assert.equal(calls.length, 2);

  assert.equal(
    calls[0].url,
    'https://api.example.test/api/v1/execution/positions/trade%2Fneeds%20encoding/close',
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {});

  assert.equal(
    calls[1].url,
    'https://api.example.test/api/v1/execution/positions/close-all',
  );
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), {});

  for (const { init } of calls) {
    assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
}

async function testBrokerDisconnect204Contract() {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => {
        throw new Error('204 responses must not be parsed as JSON');
      },
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => 'fixture-access-token',
  });

  const result = await client.disconnectBroker('conn/needs encoding');
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.example.test/api/v1/broker/connections/conn/needs encoding/disconnect',
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-access-token');
}

async function testUnauthorizedRecoveryIsSingleFlightAndRetriesOnce() {
  const calls = [];
  let token = 'expired-token';
  let recoveryCalls = 0;
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => {
    releaseRecovery = resolve;
  });

  const fakeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (init.headers.Authorization === 'Bearer expired-token') {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ statusCode: 401, message: 'Expired' }),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true }),
    };
  };

  const { createApiClient } = loadApiClient(fakeFetch);
  const client = createApiClient({
    baseUrl: 'https://api.example.test/api/v1',
    getAccessToken: () => token,
    recoverUnauthorized: async () => {
      recoveryCalls += 1;
      await recoveryGate;
      token = 'fresh-token';
      return true;
    },
  });

  const first = client.request('/fixture/one');
  const second = client.request('/fixture/two');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryCalls, 1, 'concurrent 401s must share one recovery');
  releaseRecovery();

  const results = await Promise.all([first, second]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(recoveryCalls, 1, 'recovery must remain single-flight');
  assert.equal(calls.length, 4, 'each request should run once before and once after recovery');
  assert.deepEqual(
    calls.map((call) => call.auth),
    [
      'Bearer expired-token',
      'Bearer expired-token',
      'Bearer fresh-token',
      'Bearer fresh-token',
    ],
  );
}

async function main() {
  await testMfaSetupPasswordContract();
  console.log('api-client MFA setup contract test passed.');
  await testChangePasswordContract();
  console.log('api-client change-password contract test passed.');
  await testRevokeOtherSessionsContract();
  console.log('api-client revoke-others contract test passed.');
  await testListAccountAppealsContract();
  console.log('api-client account-appeals pagination contract test passed.');
  await testListSecurityEventsContract();
  console.log('api-client security-events contract test passed.');
  await testUpdateMyProfileContract();
  console.log('api-client update-my-profile contract test passed.');
  await testChangePasswordErrorContract();
  console.log('api-client change-password failure contract test passed.');
  await testRevokeOtherSessionsNetworkErrorContract();
  console.log('api-client revoke-others network-failure contract test passed.');
  await testStartBrokerOAuthChannelContract();
  console.log('api-client oauth authorize channel contract test passed.');
  await testExchangeBrokerOAuthHandoffContract();
  console.log('api-client oauth handoff contract test passed.');
  await testActiveTradingSessionContract();
  console.log('api-client active-trading-session contract test passed.');
  await testAutomationRuntimeStatusContract();
  console.log('api-client automation-runtime contract test passed.');
  await testStartTradingSessionContract();
  console.log('api-client trading-session start contract test passed.');
  await testChangeTradingSessionModeContract();
  console.log('api-client trading-session mode-change contract test passed.');
  await testExecutionConfirmationsContract();
  console.log('api-client execution confirmations contract test passed.');
  await testConfirmExecutionConfirmation409Contract();
  console.log('api-client confirmation 409-failure contract test passed.');
  await testPositionCloseContracts();
  console.log('api-client position-close contracts test passed.');
  await testBrokerDisconnect204Contract();
  console.log('api-client broker-disconnect 204 contract test passed.');
  await testUnauthorizedRecoveryIsSingleFlightAndRetriesOnce();
  console.log('api-client single-flight unauthorized recovery test passed.');
}

main().catch((error) => {
  console.error(`api-client contract test failed: ${error.message}`);
  process.exit(1);
});
