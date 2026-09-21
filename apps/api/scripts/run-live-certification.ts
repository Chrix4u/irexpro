/**
 * run-live-certification.ts — OPERATOR-ONLY production-LIVE certification CLI
 * (Phase 3 / PLC-impl-cert-cli).
 *
 * Usage (authorized operator shell only — NEVER CI; no GitHub workflow sets
 * the gate env):
 *   pnpm --filter @irexpro/api run cert:live -- <provider>
 *
 *   <provider> : metatrader5 | oanda | ctrader | pepperstone-ctrader | icmarkets-ctrader
 *
 * This is a THIN, SAFE wrapper around the EXISTING certification engine
 * (apps/api/src/modules/broker/verification/provider-live-certification-harness.ts).
 * It adds NO certification logic and weakens NOTHING:
 *   - the gate resolution is the harness's own resolveLiveCertificationGateFromEnv
 *     (only the EXACT string 'true' enables — never re-implemented here);
 *   - the deep input validation (positive decimal cap, credential-source shape,
 *     operator identity) stays in the harness's assertLiveCertificationGates /
 *     runLiveProviderCertification, which this CLI calls unchanged;
 *   - the adapter construction uses the harness's own factories
 *     (buildMetaTraderCertificationHarness for MT5, the harness-internal
 *     buildLiveCertificationAdapter for oanda / the cTrader family);
 *   - the catalog is NEVER touched by this script. A certifiable PASS only
 *     PRINTS the exact values a human operator must apply through the
 *     reviewed manual edit of broker-catalog.ts (see
 *     docs/brokers/live-certification-runbook.md).
 *
 * SAFETY CONTRACT (CodeQL CWE-532 hygiene — same discipline as the harness):
 *   - required env VALUES are never echoed; refusal messages name the env
 *     VARIABLE names only;
 *   - credentials are read from env at run time, kept memory-only and are
 *     never printed, never logged, never written to evidence (the harness
 *     itself sanitizes every evidence field and masks account ids);
 *   - the printed summary carries only non-secret run facts: runId, brokerId,
 *     overall result, artifact path, evidence sha256 — plus, for a
 *     certifiable PASS, the exact catalog-edit values.
 *
 * Exit codes: 0 ONLY for a certifiable PASS (isCertifiablePass), 1 otherwise
 * (refused configuration, run failure, or evidence persistence failure).
 *
 * Structure note: resolveOperatorRunConfig() is a PURE exported function
 * (argv + env in, config-or-error out) so the CLI spec can test the full
 * validation contract without credentials or provider calls. main() is the
 * only side-effecting path and is guarded by `require.main === module` so
 * importing this module (e.g. from the spec or the transition verifier)
 * never triggers a run.
 */
import {
  BuiltLiveCertificationAdapter,
  LiveCertificationEvidence,
  LiveCertificationOptions,
  assertLiveCertificationGates,
  buildMetaTraderCertificationHarness,
  isCertifiablePass,
  liveCertificationArtifactFileName,
  resolveLiveCertificationGateFromEnv,
  runLiveProviderCertification,
} from '../src/modules/broker/verification/provider-live-certification-harness';

/** The operator runbook this CLI points at (printed at start). */
export const LIVE_CERTIFICATION_RUNBOOK_PATH = 'docs/brokers/live-certification-runbook.md';

/** Provider kinds the CLI can drive (mirrors the harness factory surface). */
export type LiveCertificationProvider = 'metatrader5' | 'oanda' | 'ctrader';

/**
 * The resolved, NON-SECRET operator run configuration. Credential VALUES are
 * deliberately absent — presence is validated by resolveOperatorRunConfig,
 * but the values are read from env only inside main() and never leave it.
 */
export interface OperatorRunConfig {
  /** Which factory family drives the run. */
  readonly provider: LiveCertificationProvider;
  /** The certification target brokerId passed to the harness (ctrader family keeps its alias). */
  readonly brokerId: string;
  readonly operatorId: string;
  /** EXPLICIT evidence directory — the CLI refuses the harness's '.' default. */
  readonly evidenceDir: string;
  /** The operator's explicit maximum canary exposure (presence checked here; shape by the harness). */
  readonly maxCanaryExposure: string;
  /** Optional operator-requested canary instrument. */
  readonly instrument?: string;
  /** Sanitized credential-source DESCRIPTION (never the credential) — mirrors the spec entry points. */
  readonly credentialSource: string;
}

/** Pure validation outcome: ok-config or a single safe (names-only) error. */
export type OperatorRunConfigResolution =
  | { readonly ok: true; readonly config: OperatorRunConfig }
  | { readonly ok: false; readonly error: string };

/** cTrader family aliases accepted as the positional provider argument. */
const CTRADER_FAMILY_ALIASES: readonly string[] = [
  'ctrader',
  'pepperstone-ctrader',
  'icmarkets-ctrader',
];

/** Supported positional providers (for refusal messages — names only). */
const SUPPORTED_PROVIDERS: readonly string[] = ['metatrader5', 'oanda', ...CTRADER_FAMILY_ALIASES];

/** Non-empty (trimmed) env value — never returns the value to the caller's output. */
function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * PURE argument/env validation for the operator certification run. Checks the
 * positional provider, the harness env gate (reusing the harness's own
 * resolution — only the exact string 'true' enables), the operator identity,
 * the EXPLICIT evidence dir (the CLI refuses the harness's unsafe '.'
 * default), and per-provider credential + max-canary-exposure PRESENCE.
 *
 * The error message names ONLY env variable names — never values. Deep
 * validation (positive decimal cap, credentialSource shape, etc.) remains
 * the harness's job (assertLiveCertificationGates) — this function neither
 * duplicates nor weakens it.
 */
export function resolveOperatorRunConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): OperatorRunConfigResolution {
  const problems: string[] = [];

  // pnpm run forwards the `--` argument separator verbatim (e.g.
  // `pnpm run cert:live -- oanda` reaches ts-node as `-- oanda`) — strip it
  // so the positional provider is parsed the same way under pnpm, npm and a
  // direct ts-node invocation.
  const args = argv.filter((arg) => arg !== '--');

  // ── Positional provider selection ─────────────────────────────────────────
  const requested = (args[0] ?? '').trim();
  if (!requested) {
    problems.push(
      `a provider positional argument is required (one of: ${SUPPORTED_PROVIDERS.join(' | ')}) — ` +
        `usage: pnpm --filter @irexpro/api run cert:live -- <provider>`,
    );
  } else if (requested === 'paper-broker') {
    problems.push(
      "provider 'paper-broker' can never be LIVE-certified — the paper simulation is " +
        'DEMO-only by design (refused by the harness factory as well).',
    );
  } else if (
    requested !== 'metatrader5' &&
    requested !== 'oanda' &&
    !CTRADER_FAMILY_ALIASES.includes(requested)
  ) {
    problems.push(
      `unknown provider '${requested}' (supported: ${SUPPORTED_PROVIDERS.join(' | ')}; ` +
        'paper-broker is DEMO-only and can never be LIVE-certified).',
    );
  }
  const provider: LiveCertificationProvider | null =
    requested === 'metatrader5'
      ? 'metatrader5'
      : requested === 'oanda'
        ? 'oanda'
        : CTRADER_FAMILY_ALIASES.includes(requested)
          ? 'ctrader'
          : null;

  // ── Gate (the harness's own fail-closed resolution — never re-implemented) ──
  const gate = resolveLiveCertificationGateFromEnv(env);
  if (!gate.allowLiveCertification) {
    problems.push(
      "IREXPRO_ALLOW_LIVE_CERTIFICATION must be set to the exact string 'true' in the " +
        'operator shell (current value NOT echoed — fail-closed; absent/blank/any other ' +
        'value keeps certification disabled with zero provider calls). CI never sets it.',
    );
  }

  // ── Operator identity ──────────────────────────────────────────────────────
  if (!hasValue(env.IREXPRO_LIVE_CERT_OPERATOR_ID)) {
    problems.push(
      'IREXPRO_LIVE_CERT_OPERATOR_ID is required — the accountable operator identity ' +
        'recorded in the durable evidence artifact (value never echoed).',
    );
  }

  // ── EXPLICIT evidence dir (the CLI refuses the harness default of '.') ────
  if (!hasValue(env.IREXPRO_LIVE_CERT_EVIDENCE_DIR)) {
    problems.push(
      'IREXPRO_LIVE_CERT_EVIDENCE_DIR is required by this CLI — an EXPLICIT directory for ' +
        "the durable evidence artifact. The harness's default of the current working " +
        'directory is unsafe for operator runs and is refused here (value never echoed).',
    );
  }

  // ── Per-provider credentials + explicit max canary exposure (presence only) ──
  let maxCanaryExposure: string | undefined;
  let instrument: string | undefined;
  let credentialSource = '';
  if (provider === 'metatrader5') {
    if (!hasValue(env.METAAPI_LIVE_CERT_TOKEN) && !hasValue(env.METAAPI_TOKEN)) {
      problems.push(
        'MetaTrader 5 requires the MetaAPI platform token: set METAAPI_LIVE_CERT_TOKEN ' +
          '(fallback: METAAPI_TOKEN) — value never echoed.',
      );
    }
    if (!hasValue(env.METAAPI_LIVE_CERT_ACCOUNT_ID)) {
      problems.push(
        'MetaTrader 5 requires METAAPI_LIVE_CERT_ACCOUNT_ID (the MetaAPI account UUID of ' +
          'the LIVE MT5 account) — value never echoed.',
      );
    }
    if (!hasValue(env.METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE)) {
      problems.push(
        'MetaTrader 5 requires METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE — an EXPLICIT positive ' +
          "decimal string cap in the canary instrument's quote currency, supplied by the " +
          'operator (never derived from any AI signal).',
      );
    }
    maxCanaryExposure = env.METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE;
    instrument = env.METAAPI_LIVE_CERT_INSTRUMENT?.trim() || undefined;
    credentialSource = 'env:METAAPI_LIVE_CERT_TOKEN (operator-supplied MetaAPI platform token)';
  } else if (provider === 'oanda') {
    if (!hasValue(env.OANDA_LIVE_CERT_TOKEN)) {
      problems.push(
        'OANDA requires OANDA_LIVE_CERT_TOKEN — a fxTrade LIVE personal access token ' +
          '(a practice token will FAIL the LIVE classification) — value never echoed.',
      );
    }
    if (!hasValue(env.OANDA_LIVE_CERT_ACCOUNT_ID)) {
      problems.push(
        'OANDA requires OANDA_LIVE_CERT_ACCOUNT_ID (the LIVE fxTrade account id) — ' +
          'value never echoed.',
      );
    }
    if (!hasValue(env.OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE)) {
      problems.push(
        'OANDA requires OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE — an EXPLICIT positive decimal ' +
          "string cap in the canary instrument's quote currency, supplied by the operator " +
          '(never derived from any AI signal).',
      );
    }
    maxCanaryExposure = env.OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE;
    instrument = env.OANDA_LIVE_CERT_INSTRUMENT?.trim() || undefined;
    credentialSource =
      'env:OANDA_LIVE_CERT_TOKEN (operator-supplied fxTrade personal access token)';
  } else if (provider === 'ctrader') {
    if (!hasValue(env.CTRADER_LIVE_CERT_ACCESS_TOKEN)) {
      problems.push(
        'cTrader requires CTRADER_LIVE_CERT_ACCESS_TOKEN — an OAuth access token for the ' +
          'LIVE cTrader account (id.ctrader.com consent flow) — value never echoed.',
      );
    }
    if (!hasValue(env.CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID)) {
      problems.push(
        'cTrader requires CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID (the ctidTraderAccountId of ' +
          'the LIVE account) — value never echoed.',
      );
    }
    if (!hasValue(env.CTRADER_CLIENT_ID) || !hasValue(env.CTRADER_CLIENT_SECRET)) {
      problems.push(
        'cTrader requires the platform Open API application credentials: CTRADER_CLIENT_ID ' +
          'and CTRADER_CLIENT_SECRET (values never echoed).',
      );
    }
    if (!hasValue(env.CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE)) {
      problems.push(
        'cTrader requires CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE — an EXPLICIT positive ' +
          "decimal string cap in the canary instrument's quote currency, supplied by the " +
          'operator (never derived from any AI signal).',
      );
    }
    maxCanaryExposure = env.CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE;
    instrument = env.CTRADER_LIVE_CERT_INSTRUMENT?.trim() || undefined;
    credentialSource =
      'env:CTRADER_LIVE_CERT_ACCESS_TOKEN (operator-supplied cTrader OAuth access token)';
  }

  if (problems.length > 0) {
    return {
      ok: false,
      error:
        'LIVE certification run REFUSED — resolve the following and re-run ' +
        `(env values are never echoed; zero provider calls were made):\n  - ${problems.join('\n  - ')}`,
    };
  }

  return {
    ok: true,
    config: {
      provider: provider!,
      brokerId: requested,
      operatorId: env.IREXPRO_LIVE_CERT_OPERATOR_ID!.trim(),
      evidenceDir: env.IREXPRO_LIVE_CERT_EVIDENCE_DIR!.trim(),
      maxCanaryExposure: maxCanaryExposure!.trim(),
      ...(instrument ? { instrument } : {}),
      credentialSource,
    },
  };
}

// ─── Shared catalog-transition value builders (also used by the verifier) ────

/** The catalog certificationRunRef form: `<runId>@sha256:<evidenceSha256>`. */
export function buildCertificationRunRef(evidence: LiveCertificationEvidence): string {
  return `${evidence.runId}@sha256:${evidence.evidenceSha256}`;
}

/** The catalog verifiedAt form: the run's own finishedAt (ISO, from the artifact). */
export function buildCertificationVerifiedAt(evidence: LiveCertificationEvidence): string {
  return evidence.finishedAt;
}

/**
 * The SANITIZED catalog evidenceRef form: points at the durable artifact by
 * its canonical file name (brokerId + runId + UTC timestamp — no secrets, no
 * absolute operator paths), with the retention caveat spelled out.
 */
export function buildCertificationCatalogEvidenceRef(evidence: LiveCertificationEvidence): string {
  const fileName = liveCertificationArtifactFileName(
    evidence.brokerId,
    evidence.runId,
    new Date(evidence.finishedAt),
  );
  return `live-certification artifact ${fileName} (retained in the operator evidence store; never committed)`;
}

// ─── main (side-effecting; only runs when executed as a script) ──────────────

/** Reads credential VALUES from env (memory-only; never printed, never in evidence). */
function readCredentials(
  config: OperatorRunConfig,
  env: NodeJS.ProcessEnv,
): { apiKey?: string; accountId: string } {
  switch (config.provider) {
    case 'metatrader5':
      // Mirrors metatrader5.live-certification.spec.ts: the platform token
      // reaches the adapter through buildMetaTraderCertificationHarness; the
      // per-run credential is the MetaApi account UUID.
      return { accountId: env.METAAPI_LIVE_CERT_ACCOUNT_ID!.trim() };
    case 'oanda':
      return {
        apiKey: env.OANDA_LIVE_CERT_TOKEN!.trim(),
        accountId: env.OANDA_LIVE_CERT_ACCOUNT_ID!.trim(),
      };
    case 'ctrader':
      return {
        apiKey: env.CTRADER_LIVE_CERT_ACCESS_TOKEN!.trim(),
        accountId: env.CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID!.trim(),
      };
  }
}

/** Prints the safe run summary (non-secret run facts only). */
function printRunSummary(evidence: LiveCertificationEvidence): void {
  console.log('── LIVE certification run summary (sanitized — no credentials by construction) ──');
  console.log(`runId               : ${evidence.runId}`);
  console.log(`brokerId            : ${evidence.brokerId}`);
  console.log(`mode                : ${evidence.mode}`);
  console.log(`overall             : ${evidence.overall}`);
  console.log(`certificationResult : ${evidence.certificationResult}`);
  console.log(`evidenceState       : ${evidence.evidenceState}`);
  if (evidence.artifactPath) {
    // CodeQL-safe pointer (Round 7.1 discipline: the console is NEVER an
    // evidence surface and env-derived values — the operator evidence
    // DIRECTORY comes from IREXPRO_LIVE_CERT_EVIDENCE_DIR — are never
    // printed). Print only the canonical file NAME reconstructed from the
    // untainted run record fields; the operator knows their own directory.
    console.log(
      `artifact            : ${liveCertificationArtifactFileName(
        evidence.brokerId,
        evidence.runId,
        new Date(evidence.finishedAt),
      )} (in the operator evidence directory — IREXPRO_LIVE_CERT_EVIDENCE_DIR)`,
    );
  }
  console.log(`evidenceSha256      : ${evidence.evidenceSha256}`);
  console.log(
    `steps               : ${evidence.summary.passed} passed / ${evidence.summary.failed} failed / ` +
      `${evidence.summary.skipped} skipped`,
  );
}

/** Prints the EXACT catalog-edit values a certifiable PASS authorizes (review-gated). */
function printCatalogTransitionValues(evidence: LiveCertificationEvidence): void {
  console.log('── Catalog transition values (apply ONLY via the reviewed manual edit of ──');
  console.log('   apps/api/src/modules/broker/registry/broker-catalog.ts — never automatically):');
  console.log(`productionLiveVerification: {`);
  console.log(`  status: 'VERIFIED',`);
  console.log(`  verifiedAt: '${buildCertificationVerifiedAt(evidence)}',`);
  console.log(`  evidenceRef: '${buildCertificationCatalogEvidenceRef(evidence)}',`);
  console.log(`  certifiedVia: 'HARNESS_CERTIFIED',`);
  console.log(`  certificationRunRef: '${buildCertificationRunRef(evidence)}',`);
  console.log(`}`);
  console.log(
    'After the reviewed edit, verify it against this artifact with: ' +
      'pnpm --filter @irexpro/api run cert:verify-transition -- --evidence <artifactPath>',
  );
}

async function main(): Promise<void> {
  console.log(`[cert:live] Operator runbook: ${LIVE_CERTIFICATION_RUNBOOK_PATH}`);
  const resolution = resolveOperatorRunConfig(process.argv.slice(2), process.env);
  if (!resolution.ok) {
    console.error(`\n${resolution.error}\n`);
    console.error(`See ${LIVE_CERTIFICATION_RUNBOOK_PATH} for the full operator procedure.`);
    process.exitCode = 1;
    return;
  }
  const config = resolution.config;
  const env = process.env;

  // Credential values: read here, memory-only, never printed (presence was
  // validated by the pure resolution above; the harness re-asserts every gate
  // before any provider call).
  const credentials = readCredentials(config, env);
  const options: LiveCertificationOptions = {
    gate: resolveLiveCertificationGateFromEnv(env),
    target: {
      brokerId: config.brokerId,
      accountId: credentials.accountId,
      credentialSource: config.credentialSource,
    },
    operator: { operatorId: config.operatorId, evidenceDir: config.evidenceDir },
    maxCanaryExposure: config.maxCanaryExposure,
    credentials,
    ...(config.instrument ? { instrument: config.instrument } : {}),
  };
  // The harness's own gate assertion — evaluated BEFORE any adapter is built
  // (defense in depth on top of the pure resolution).
  assertLiveCertificationGates(options);

  let evidence: LiveCertificationEvidence;
  if (config.provider === 'metatrader5') {
    // MT5 goes through the platform MetaApi token factory (the harness cannot
    // build it from brokerId); the CLI owns the dispose — mirroring
    // metatrader5.live-certification.spec.ts.
    const built: BuiltLiveCertificationAdapter = await buildMetaTraderCertificationHarness(
      env.METAAPI_LIVE_CERT_TOKEN?.trim() || env.METAAPI_TOKEN?.trim(),
    );
    try {
      evidence = await runLiveProviderCertification({ ...options, adapter: built.adapter });
    } finally {
      try {
        await built.dispose?.();
      } catch {
        // best-effort teardown — the evidence already records the run outcome.
      }
    }
  } else {
    // oanda + the cTrader family: the harness builds and disposes the REAL
    // adapter itself through buildLiveCertificationAdapter (it refuses
    // paper-broker and unknown ids) — mirroring the oanda/ctrader spec entry
    // points, which pass no adapter.
    evidence = await runLiveProviderCertification(options);
  }

  printRunSummary(evidence);

  if (isCertifiablePass(evidence)) {
    printCatalogTransitionValues(evidence);
    console.log(
      '[cert:live] CERTIFIABLE PASS — durable evidence written + read-back verified. ' +
        'The catalog flip stays a manual, reviewed edit.',
    );
    process.exitCode = 0;
  } else {
    console.error(
      '[cert:live] NOT CERTIFIABLE (isCertifiablePass === false) — this run authorizes NO ' +
        'catalog change. A console PASS alone is never sufficient: certification requires a ' +
        'durably persisted, read-back-verified evidence artifact.',
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(
      '[cert:live] LIVE certification run failed: ' +
        (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
    );
    console.error(`See ${LIVE_CERTIFICATION_RUNBOOK_PATH} for the operator procedure.`);
    process.exitCode = 1;
  });
}
