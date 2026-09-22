#!/usr/bin/env node

/**
 * iRexPro PAPER/DEMO UAT readiness probe.
 *
 * Safe-by-default:
 * - authenticated read-only checks unless IREXPRO_UAT_ALLOW_MUTATIONS=true
 * - never enables LIVE trading
 * - never changes execution mode to FULL_AUTO for a LIVE account
 * - if it starts a PAPER_ONLY session itself, it stops only that session in finally
 *
 * Node 20+ required (native fetch).
 */

const API_BASE = (process.env.IREXPRO_UAT_API_BASE ||
  'https://irexpro.lightworldtech.com/api/v1').replace(/\/$/, '');
const TOKEN = (process.env.IREXPRO_UAT_BEARER_TOKEN || '').trim();
const MODE = (process.env.IREXPRO_UAT_MODE || 'PAPER').trim().toUpperCase();
const CONNECTION_ID = (process.env.IREXPRO_UAT_BROKER_CONNECTION_ID || '').trim();
const ALLOW_MUTATIONS =
  String(process.env.IREXPRO_UAT_ALLOW_MUTATIONS || '').toLowerCase() === 'true';
const REQUIRE_TRAINED_MODEL =
  String(process.env.IREXPRO_UAT_REQUIRE_TRAINED_MODEL || 'true').toLowerCase() !== 'false';
const STATUS_TIMEOUT_SECONDS = Number(
  process.env.IREXPRO_UAT_STATUS_TIMEOUT_SECONDS || '90',
);

const SIX_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];

if (!TOKEN) {
  console.error(
    'UAT HOLD: IREXPRO_UAT_BEARER_TOKEN is required. Do not commit or print the token.',
  );
  process.exit(2);
}
if (!['PAPER', 'DEMO'].includes(MODE)) {
  console.error('UAT HOLD: IREXPRO_UAT_MODE must be PAPER or DEMO.');
  process.exit(2);
}
if (!Number.isFinite(STATUS_TIMEOUT_SECONDS) || STATUS_TIMEOUT_SECONDS < 0) {
  console.error('UAT HOLD: IREXPRO_UAT_STATUS_TIMEOUT_SECONDS must be a non-negative number.');
  process.exit(2);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|credential|api.?key|authorization/i.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redact(child);
    }
  }
  return result;
}

function pass(label, detail = '') {
  console.log(`PASS ${label}${detail ? ` :: ${detail}` : ''}`);
}

function info(label, detail = '') {
  console.log(`INFO ${label}${detail ? ` :: ${detail}` : ''}`);
}

function hold(label, detail = '') {
  throw new Error(`${label}${detail ? ` :: ${detail}` : ''}`);
}

async function api(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers || {}),
    },
  });

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { nonJsonBody: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    const safe = JSON.stringify(redact(payload));
    throw new Error(`${init.method || 'GET'} ${path} -> HTTP ${response.status} ${safe}`);
  }
  return payload;
}

function selectConnection(connections) {
  if (!Array.isArray(connections) || connections.length === 0) {
    hold('BROKER_CONNECTION_MISSING', 'No broker connection exists for this user.');
  }

  if (CONNECTION_ID) {
    const exact = connections.find((item) => item.id === CONNECTION_ID);
    if (!exact) {
      hold(
        'BROKER_CONNECTION_NOT_FOUND',
        `Requested connection ${CONNECTION_ID} is not owned by the authenticated user.`,
      );
    }
    return exact;
  }

  if (MODE === 'PAPER') {
    const paper = connections.filter((item) => item.brokerId === 'paper-broker');
    if (paper.length === 1) return paper[0];
    if (paper.length > 1) {
      hold(
        'BROKER_CONNECTION_AMBIGUOUS',
        'Multiple paper-broker connections exist; set IREXPRO_UAT_BROKER_CONNECTION_ID.',
      );
    }
    hold(
      'PAPER_BROKER_MISSING',
      'No paper-broker connection found; create/select the internal paper simulator first.',
    );
  }

  const demos = connections.filter(
    (item) => item.accountType === 'DEMO' && item.brokerId !== 'paper-broker',
  );
  if (demos.length === 1) return demos[0];
  if (demos.length > 1) {
    hold(
      'BROKER_CONNECTION_AMBIGUOUS',
      'Multiple real-provider DEMO connections exist; set IREXPRO_UAT_BROKER_CONNECTION_ID.',
    );
  }
  hold(
    'DEMO_BROKER_MISSING',
    'No real-provider DEMO connection found; connect an OANDA/cTrader/MetaTrader demo account first.',
  );
}

function unwrapSession(payload) {
  if (!payload) return null;
  return payload.session ?? payload;
}

async function waitForAutomationStatus(sessionId) {
  const deadline = Date.now() + STATUS_TIMEOUT_SECONDS * 1000;
  let last = null;

  do {
    last = await api(
      `/trading/sessions/${encodeURIComponent(sessionId)}/automation-status`,
    );

    const modelReady =
      last?.model_loaded === true &&
      last?.model_mode === 'trained_xgboost_mtf' &&
      typeof last?.model_version === 'string' &&
      last.model_version.length > 0;

    const schedulerReady = last?.enabled === true && last?.registered === true && last?.active === true;

    if ((!REQUIRE_TRAINED_MODEL || modelReady) && schedulerReady) return last;

    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } while (true);

  return last;
}

let sessionStartedByHarness = null;

try {
  const [profile, onboarding, risk, connections, activeEnvelope, overview] =
    await Promise.all([
      api('/users/me'),
      api('/users/me/onboarding-status'),
      api('/risk/status'),
      api('/broker/connections'),
      api('/trading/sessions/active'),
      api('/live-account/overview'),
    ]);

  pass('AUTHENTICATED_USER', profile?.id ? `user=${profile.id}` : 'profile reachable');
  info('ONBOARDING_STATUS', JSON.stringify(redact(onboarding)));

  if (risk?.killSwitchActive === true) {
    hold('KILL_SWITCH_ACTIVE', 'Deactivate the personal kill switch before UAT.');
  }
  if (risk?.brokerConnected !== true || risk?.canTrade !== true) {
    hold('RISK_NOT_TRADE_READY', JSON.stringify(redact(risk)));
  }
  pass('RISK_READY', 'kill switch clear and server reports canTrade=true');

  const connection = selectConnection(connections);
  if (connection.status !== 'CONNECTED') {
    hold('BROKER_NOT_CONNECTED', `connection=${connection.id} status=${connection.status}`);
  }
  if (MODE === 'DEMO' && connection.accountType !== 'DEMO') {
    hold(
      'BROKER_ENVIRONMENT_MISMATCH',
      `DEMO UAT requires accountType=DEMO, got ${connection.accountType}`,
    );
  }
  if (MODE === 'PAPER' && connection.brokerId !== 'paper-broker') {
    hold(
      'PAPER_EXECUTION_BOUNDARY_MISMATCH',
      `PAPER UAT requires brokerId=paper-broker, got ${connection.brokerId}`,
    );
  }
  pass(
    'BROKER_READY',
    `id=${connection.id} broker=${connection.brokerId} environment=${connection.accountType}`,
  );

  const allocation = await api(
    `/execution/capital-allocation?brokerConnectionId=${encodeURIComponent(connection.id)}`,
  );
  if (!allocation?.hasAllocation || !allocation?.allocatedCapital) {
    hold(
      'CAPITAL_ALLOCATION_MISSING',
      'Set an explicit AI capital allocation for the selected test connection.',
    );
  }
  pass('CAPITAL_ALLOCATION_READY', `amount=${allocation.allocatedCapital}`);

  let session = unwrapSession(activeEnvelope);
  if (session && session.brokerConnectionId !== connection.id) {
    hold(
      'ACTIVE_SESSION_BOUND_TO_DIFFERENT_CONNECTION',
      `session=${session.id} brokerConnectionId=${session.brokerConnectionId}`,
    );
  }

  if (!session && ALLOW_MUTATIONS) {
    const started = await api('/trading/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        brokerConnectionId: connection.id,
        executionMode: MODE === 'PAPER' ? 'PAPER_ONLY' : 'FULL_AUTO',
      }),
    });
    session = unwrapSession(started);
    if (!session?.id) {
      hold('SESSION_START_CONTRACT_MISMATCH', JSON.stringify(redact(started)));
    }
    sessionStartedByHarness = session.id;
    pass(
      'SESSION_STARTED_BY_HARNESS',
      `session=${session.id} executionMode=${session.executionMode}`,
    );
  }

  if (!session) {
    info(
      'SESSION_NOT_ACTIVE',
      'Read-only readiness passed so far. Set IREXPRO_UAT_ALLOW_MUTATIONS=true to start a controlled test session.',
    );
  } else {
    if (!['ACTIVE', 'PAUSED'].includes(session.status)) {
      hold('SESSION_NOT_ACTIVE', `session=${session.id} status=${session.status}`);
    }
    pass(
      'SESSION_AUTHORITY_READY',
      `session=${session.id} mode=${session.executionMode} generation=${session.authorityGeneration}`,
    );

    const runtime = await waitForAutomationStatus(session.id);
    if (!runtime?.enabled || !runtime?.registered || !runtime?.active) {
      hold('AI_SCHEDULER_NOT_READY', JSON.stringify(redact(runtime)));
    }

    if (REQUIRE_TRAINED_MODEL) {
      if (
        runtime.model_loaded !== true ||
        runtime.model_mode !== 'trained_xgboost_mtf' ||
        !runtime.model_version
      ) {
        hold(
          'TRAINED_MODEL_NOT_ACTIVE',
          `loaded=${runtime.model_loaded} mode=${runtime.model_mode} version=${runtime.model_version}`,
        );
      }
      pass(
        'TRAINED_MODEL_ACTIVE',
        `version=${runtime.model_version} mode=${runtime.model_mode}`,
      );
    } else {
      info(
        'MODEL_REQUIREMENT_DISABLED',
        `loaded=${runtime.model_loaded} mode=${runtime.model_mode} version=${runtime.model_version}`,
      );
    }

    const instruments = Array.isArray(runtime.instruments)
      ? runtime.instruments.map((item) => String(item).toUpperCase())
      : [];
    const missingPairs = SIX_PAIRS.filter((pair) => !instruments.includes(pair));
    if (missingPairs.length > 0) {
      hold('SIX_PAIR_RUNTIME_INCOMPLETE', `missing=${missingPairs.join(',')}`);
    }
    pass('SIX_PAIR_RUNTIME_READY', instruments.join(','));

    info(
      'RUNTIME_SIGNAL_STATE',
      JSON.stringify({
        timeframe: runtime.timeframe,
        interval_seconds: runtime.interval_seconds,
        last_run_at: runtime.last_run_at,
        last_decision: runtime.last_decision,
        last_reason: runtime.last_reason,
        last_confidence_score: runtime.last_confidence_score,
        confidence_threshold: runtime.confidence_threshold,
        last_market_data_at: runtime.last_market_data_at,
        market_data_age_seconds: runtime.market_data_age_seconds,
        last_publish_failed: runtime.last_publish_failed,
      }),
    );
  }

  const [positions, recent] = await Promise.all([
    api('/execution/positions/open'),
    api('/execution/trades/recent?limit=20'),
  ]);
  pass(
    'EXECUTION_READ_MODELS_READY',
    `open_positions=${Array.isArray(positions) ? positions.length : 'unknown'} recent=${Array.isArray(recent) ? recent.length : 'unknown'}`,
  );

  pass(
    'LIVE_ACCOUNT_READ_MODEL_READY',
    overview ? 'overview reachable for authenticated user' : 'empty overview response',
  );

  console.log(
    ALLOW_MUTATIONS
      ? 'UAT_READINESS_PASS mode=' + MODE + ' mutation_mode=controlled'
      : 'UAT_READINESS_PASS mode=' + MODE + ' mutation_mode=read_only',
  );
} catch (error) {
  console.error(`UAT_HOLD ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (sessionStartedByHarness) {
    try {
      const stopped = await api(
        `/trading/sessions/${encodeURIComponent(sessionStartedByHarness)}/stop`,
        { method: 'POST' },
      );
      console.log(
        'PASS SESSION_STARTED_BY_HARNESS_STOPPED :: ' +
          JSON.stringify(redact(stopped?.positionCloseSummary || stopped || {})),
      );
    } catch (error) {
      console.error(
        'UAT_HOLD HARNESS_SESSION_STOP_FAILED :: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      process.exitCode = 1;
    }
  }
}
