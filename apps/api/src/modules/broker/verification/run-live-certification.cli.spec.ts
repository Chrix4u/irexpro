import {
  LIVE_CERTIFICATION_STAGES,
  LiveCertificationEvidence,
  LiveCertificationRunRecord,
  computeLiveCertificationEvidenceSha256,
} from './provider-live-certification-harness';
import {
  OperatorRunConfigResolution,
  buildCertificationCatalogEvidenceRef,
  buildCertificationRunRef,
  buildCertificationVerifiedAt,
  resolveOperatorRunConfig,
} from '../../../../scripts/run-live-certification';
import {
  CatalogEntryInput,
  parseVerifyTransitionArgs,
  verifyCatalogTransitionAgainstEvidence,
} from '../../../../scripts/verify-live-certification-catalog-transition';

/**
 * CLI spec for the operator LIVE-certification scripts
 * (apps/api/scripts/run-live-certification.ts +
 * apps/api/scripts/verify-live-certification-catalog-transition.ts —
 * PLC-impl-cert-cli, Phase 3).
 *
 * PURE-FUNCTION tests only: no real credentials, no provider calls, no
 * harness execution, no file I/O. The full argument/env validation contract
 * of the run CLI and the full catalog-transition verification contract of
 * the verifier are exercised through their exported pure functions — the
 * side-effecting main() paths stay operator-run only (guarded by
 * `require.main === module`, which importing this spec proves: importing the
 * scripts triggers nothing).
 *
 * Location note (bootstrap-admin.cli.spec.ts convention): jest rootDir is
 * apps/api/src, so CLI specs live under src/ next to the module they wrap.
 */

// ─── resolveOperatorRunConfig: fixtures ───────────────────────────────────────

const SPEC_OPERATOR_ID = 'spec-operator';
const SPEC_EVIDENCE_DIR = '/tmp/irexpro-live-cert-evidence-spec';
const SPEC_OANDA_TOKEN = 'SPEC-OANDA-TOKEN-SENTINEL-987654321';
const SPEC_OANDA_ACCOUNT = '101-004-1234567-001';
const SPEC_MT5_TOKEN = 'SPEC-METAAPI-TOKEN-SENTINEL-987654321';
const SPEC_MT5_ACCOUNT = 'spec-metaapi-account-uuid';
const SPEC_CTRADER_TOKEN = 'SPEC-CTRADER-TOKEN-SENTINEL-987654321';
const SPEC_CTRADER_ACCOUNT = '12345678';
const SPEC_CTRADER_CLIENT_ID = 'spec-ctrader-client-id';
const SPEC_CTRADER_CLIENT_SECRET = 'spec-ctrader-client-secret';
const SPEC_EXPOSURE = '2000';

/** A fully-populated env (every provider's contract satisfied) with overrides. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    IREXPRO_ALLOW_LIVE_CERTIFICATION: 'true',
    IREXPRO_LIVE_CERT_OPERATOR_ID: SPEC_OPERATOR_ID,
    IREXPRO_LIVE_CERT_EVIDENCE_DIR: SPEC_EVIDENCE_DIR,
    OANDA_LIVE_CERT_TOKEN: SPEC_OANDA_TOKEN,
    OANDA_LIVE_CERT_ACCOUNT_ID: SPEC_OANDA_ACCOUNT,
    OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE: SPEC_EXPOSURE,
    METAAPI_LIVE_CERT_TOKEN: SPEC_MT5_TOKEN,
    METAAPI_LIVE_CERT_ACCOUNT_ID: SPEC_MT5_ACCOUNT,
    METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE: SPEC_EXPOSURE,
    CTRADER_LIVE_CERT_ACCESS_TOKEN: SPEC_CTRADER_TOKEN,
    CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID: SPEC_CTRADER_ACCOUNT,
    CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE: SPEC_EXPOSURE,
    CTRADER_CLIENT_ID: SPEC_CTRADER_CLIENT_ID,
    CTRADER_CLIENT_SECRET: SPEC_CTRADER_CLIENT_SECRET,
    ...overrides,
  };
}

/** Sentinel env VALUES that must never surface in any refusal message or config. */
const SECRET_SENTINELS: readonly string[] = [
  SPEC_OANDA_TOKEN,
  SPEC_MT5_TOKEN,
  SPEC_CTRADER_TOKEN,
  SPEC_CTRADER_ACCOUNT,
  SPEC_OANDA_ACCOUNT,
  SPEC_MT5_ACCOUNT,
  SPEC_CTRADER_CLIENT_SECRET,
];

// ─── resolveOperatorRunConfig: the gate ───────────────────────────────────────

describe('resolveOperatorRunConfig — IREXPRO_ALLOW_LIVE_CERTIFICATION gate (fail-closed)', () => {
  it.each(['TRUE', 'True', 'true ', 'yes', '1', 'false', '', undefined])(
    'refuses when the gate env is %p (only the exact string "true" enables)',
    (gateValue) => {
      const resolution: OperatorRunConfigResolution = resolveOperatorRunConfig(
        ['oanda'],
        validEnv({ IREXPRO_ALLOW_LIVE_CERTIFICATION: gateValue }),
      );
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) {
        expect(resolution.error).toContain('IREXPRO_ALLOW_LIVE_CERTIFICATION');
        expect(resolution.error).toContain("exact string 'true'");
      }
    },
  );

  it('refuses when the gate env is a sentinel value WITHOUT echoing that value', () => {
    const sentinel = 'totally-wrong-sentinel-gate-value';
    const resolution = resolveOperatorRunConfig(
      ['oanda'],
      validEnv({ IREXPRO_ALLOW_LIVE_CERTIFICATION: sentinel }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).not.toContain(sentinel);
    }
  });

  it('accepts only the exact string "true"', () => {
    const resolution = resolveOperatorRunConfig(['oanda'], validEnv());
    expect(resolution.ok).toBe(true);
  });

  it('strips a pnpm-forwarded "--" argument separator before parsing the provider', () => {
    const resolution = resolveOperatorRunConfig(['--', 'oanda'], validEnv());
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.config.provider).toBe('oanda');
      expect(resolution.config.brokerId).toBe('oanda');
    }
  });
});

// ─── resolveOperatorRunConfig: required operator inputs ──────────────────────

describe('resolveOperatorRunConfig — required operator inputs', () => {
  it('refuses when IREXPRO_LIVE_CERT_OPERATOR_ID is missing or blank', () => {
    for (const operatorId of [undefined, '', '   ']) {
      const resolution = resolveOperatorRunConfig(
        ['oanda'],
        validEnv({ IREXPRO_LIVE_CERT_OPERATOR_ID: operatorId }),
      );
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) {
        expect(resolution.error).toContain('IREXPRO_LIVE_CERT_OPERATOR_ID');
      }
    }
  });

  it('refuses without an EXPLICIT IREXPRO_LIVE_CERT_EVIDENCE_DIR (the harness "." default is unsafe)', () => {
    for (const evidenceDir of [undefined, '', '   ']) {
      const resolution = resolveOperatorRunConfig(
        ['oanda'],
        validEnv({ IREXPRO_LIVE_CERT_EVIDENCE_DIR: evidenceDir }),
      );
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) {
        expect(resolution.error).toContain('IREXPRO_LIVE_CERT_EVIDENCE_DIR');
      }
    }
  });

  it('refuses when the OANDA max canary exposure is missing (explicit cap, never AI-derived)', () => {
    const resolution = resolveOperatorRunConfig(
      ['oanda'],
      validEnv({ OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE: undefined }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE');
      expect(resolution.error).toContain('never derived from any AI signal');
    }
  });
});

// ─── resolveOperatorRunConfig: provider selection ────────────────────────────

describe('resolveOperatorRunConfig — provider selection', () => {
  it('refuses an unknown provider and lists the supported ones', () => {
    const resolution = resolveOperatorRunConfig(['binance'], validEnv());
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain("unknown provider 'binance'");
      expect(resolution.error).toContain('metatrader5');
      expect(resolution.error).toContain('oanda');
      expect(resolution.error).toContain('ctrader');
      expect(resolution.error).toContain('pepperstone-ctrader');
      expect(resolution.error).toContain('icmarkets-ctrader');
    }
  });

  it('refuses paper-broker explicitly (DEMO-only, can never be LIVE-certified)', () => {
    const resolution = resolveOperatorRunConfig(['paper-broker'], validEnv());
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('paper-broker');
      expect(resolution.error).toContain('DEMO-only');
    }
  });

  it('refuses when no provider positional argument is given', () => {
    const resolution = resolveOperatorRunConfig([], validEnv());
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('provider positional argument');
      expect(resolution.error).toContain('cert:live');
    }
  });

  it('resolves a valid metatrader5 config with the correct brokerId', () => {
    const resolution = resolveOperatorRunConfig(['metatrader5'], validEnv());
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.config.provider).toBe('metatrader5');
      expect(resolution.config.brokerId).toBe('metatrader5');
      expect(resolution.config.operatorId).toBe(SPEC_OPERATOR_ID);
      expect(resolution.config.evidenceDir).toBe(SPEC_EVIDENCE_DIR);
      expect(resolution.config.maxCanaryExposure).toBe(SPEC_EXPOSURE);
      expect(resolution.config.credentialSource).toContain('METAAPI_LIVE_CERT_TOKEN');
    }
  });

  it('accepts the METAAPI_TOKEN fallback when METAAPI_LIVE_CERT_TOKEN is absent', () => {
    const resolution = resolveOperatorRunConfig(
      ['metatrader5'],
      validEnv({ METAAPI_LIVE_CERT_TOKEN: undefined, METAAPI_TOKEN: 'spec-fallback-token' }),
    );
    expect(resolution.ok).toBe(true);
  });

  it('refuses metatrader5 when neither METAAPI_LIVE_CERT_TOKEN nor METAAPI_TOKEN is set', () => {
    const resolution = resolveOperatorRunConfig(
      ['metatrader5'],
      validEnv({ METAAPI_LIVE_CERT_TOKEN: undefined, METAAPI_TOKEN: undefined }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('METAAPI_LIVE_CERT_TOKEN');
      expect(resolution.error).toContain('METAAPI_TOKEN');
    }
  });

  it('resolves a valid oanda config with the correct brokerId', () => {
    const resolution = resolveOperatorRunConfig(['oanda'], validEnv());
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.config.provider).toBe('oanda');
      expect(resolution.config.brokerId).toBe('oanda');
      expect(resolution.config.credentialSource).toContain('OANDA_LIVE_CERT_TOKEN');
    }
  });

  it('refuses oanda when the token is missing, naming the env variable only', () => {
    const resolution = resolveOperatorRunConfig(
      ['oanda'],
      validEnv({ OANDA_LIVE_CERT_TOKEN: undefined }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('OANDA_LIVE_CERT_TOKEN');
    }
  });

  it.each(['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader'])(
    'maps the cTrader family argument %p to the family adapter config with the brokerId preserved',
    (alias) => {
      const resolution = resolveOperatorRunConfig([alias], validEnv());
      expect(resolution.ok).toBe(true);
      if (resolution.ok) {
        expect(resolution.config.provider).toBe('ctrader');
        expect(resolution.config.brokerId).toBe(alias);
        expect(resolution.config.credentialSource).toContain('CTRADER_LIVE_CERT_ACCESS_TOKEN');
      }
    },
  );

  it('refuses ctrader when the platform Open API application credentials are missing', () => {
    const resolution = resolveOperatorRunConfig(
      ['ctrader'],
      validEnv({ CTRADER_CLIENT_ID: undefined, CTRADER_CLIENT_SECRET: undefined }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('CTRADER_CLIENT_ID');
      expect(resolution.error).toContain('CTRADER_CLIENT_SECRET');
    }
  });

  it('refuses ctrader when the OAuth access token is missing', () => {
    const resolution = resolveOperatorRunConfig(
      ['pepperstone-ctrader'],
      validEnv({ CTRADER_LIVE_CERT_ACCESS_TOKEN: undefined }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('CTRADER_LIVE_CERT_ACCESS_TOKEN');
    }
  });

  it('carries the optional per-provider instrument when set', () => {
    const resolution = resolveOperatorRunConfig(
      ['oanda'],
      validEnv({ OANDA_LIVE_CERT_INSTRUMENT: 'EUR_USD' }),
    );
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.config.instrument).toBe('EUR_USD');
    }
  });
});

// ─── resolveOperatorRunConfig: secret hygiene ─────────────────────────────────

describe('resolveOperatorRunConfig — refusal and config hygiene (values never echoed)', () => {
  it('never includes env VALUES in refusal messages (env variable names only)', () => {
    // Break several contract points at once so the refusal message is maximal,
    // while sentinel VALUES remain present in the env under test.
    const resolution = resolveOperatorRunConfig(
      ['metatrader5'],
      validEnv({
        IREXPRO_ALLOW_LIVE_CERTIFICATION: 'wrong',
        METAAPI_LIVE_CERT_TOKEN: undefined,
        METAAPI_TOKEN: SPEC_MT5_TOKEN,
        METAAPI_LIVE_CERT_ACCOUNT_ID: undefined,
        METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE: undefined,
        IREXPRO_LIVE_CERT_OPERATOR_ID: undefined,
        IREXPRO_LIVE_CERT_EVIDENCE_DIR: undefined,
      }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      for (const sentinel of SECRET_SENTINELS) {
        expect(resolution.error).not.toContain(sentinel);
      }
    }
  });

  it('never carries credential VALUES in the resolved config (memory-only at run time)', () => {
    const resolution = resolveOperatorRunConfig(['oanda'], validEnv());
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      const serialized = JSON.stringify(resolution.config);
      expect(serialized).not.toContain(SPEC_OANDA_TOKEN);
      expect(serialized).not.toContain(SPEC_OANDA_ACCOUNT);
      expect(serialized).not.toContain(SPEC_CTRADER_CLIENT_SECRET);
    }
  });
});

// ─── verifyCatalogTransitionAgainstEvidence: fixtures ────────────────────────

const SYNTHETIC_RUN_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SYNTHETIC_FINISHED_AT = '2025-06-01T10:02:30.000Z';

/**
 * A structurally valid, internally consistent certifiable-PASS evidence
 * record. `recordOverrides` are applied BEFORE hashing (still-consistent
 * artifacts, e.g. a different broker); `evidenceOverrides` are applied AFTER
 * hashing (deliberate tampering — the verifier must catch them).
 */
function buildSyntheticPassEvidence(
  options: {
    recordOverrides?: Partial<LiveCertificationRunRecord>;
    evidenceOverrides?: Partial<LiveCertificationEvidence>;
  } = {},
): LiveCertificationEvidence {
  const base: LiveCertificationRunRecord = {
    runId: SYNTHETIC_RUN_ID,
    mode: 'LIVE',
    brokerId: 'oanda',
    operatorId: SPEC_OPERATOR_ID,
    target: {
      brokerId: 'oanda',
      accountIdMasked: '•••5678',
      credentialSource:
        'env:OANDA_LIVE_CERT_TOKEN (operator-supplied fxTrade personal access token)',
    },
    canary: {
      instrument: 'EUR_USD',
      requestedSize: '0.01',
      providerMinimum: '0.01',
      cap: { maxCanaryExposure: SPEC_EXPOSURE, derivedLotCap: '0.01' },
      actualSize: '0.01',
      direction: 'BUY',
    },
    baselineExposure: {
      capturedAt: '2025-06-01T10:00:00.000Z',
      positions: { count: 0, maskedIds: [] },
      workingOrders: { count: 0, maskedIds: [] },
    },
    postExposure: {
      capturedAt: SYNTHETIC_FINISHED_AT,
      positions: { count: 0, maskedIds: [] },
      workingOrders: { count: 0, maskedIds: [] },
    },
    startedAt: '2025-06-01T10:00:00.000Z',
    finishedAt: SYNTHETIC_FINISHED_AT,
    steps: LIVE_CERTIFICATION_STAGES.map((name) => ({
      name,
      status: name === 'account-discovery' ? ('SKIPPED' as const) : ('PASS' as const),
    })),
    summary: { passed: 15, failed: 0, skipped: 1 },
    overall: 'PASS',
  };
  const record: LiveCertificationRunRecord = { ...base, ...options.recordOverrides };
  return {
    ...record,
    evidenceSha256: computeLiveCertificationEvidenceSha256(record),
    evidenceState: 'PERSISTED',
    certificationResult: 'PASS',
    artifactPath: `/operator-evidence/live-certification-${record.brokerId}-${record.runId}-20250601-100230.json`,
    ...options.evidenceOverrides,
  };
}

function unverifiedEntry(id: string): CatalogEntryInput {
  return { id, productionLiveVerification: { status: 'UNVERIFIED' } };
}

function legacyVerifiedEntry(id: string): CatalogEntryInput {
  return {
    id,
    productionLiveVerification: {
      status: 'VERIFIED',
      verifiedAt: null,
      evidenceRef: 'production operation — legacy attestation',
      certifiedVia: 'LEGACY_ATTESTATION',
      certificationRunRef: null,
    },
  };
}

function harnessCertifiedEntry(
  id: string,
  evidence: LiveCertificationEvidence,
  overrides: { verifiedAt?: string; evidenceRef?: string; certificationRunRef?: string } = {},
): CatalogEntryInput {
  return {
    id,
    productionLiveVerification: {
      status: 'VERIFIED',
      verifiedAt: overrides.verifiedAt ?? buildCertificationVerifiedAt(evidence),
      evidenceRef: overrides.evidenceRef ?? buildCertificationCatalogEvidenceRef(evidence),
      certifiedVia: 'HARNESS_CERTIFIED',
      certificationRunRef: overrides.certificationRunRef ?? buildCertificationRunRef(evidence),
    },
  };
}

// ─── verifyCatalogTransitionAgainstEvidence ──────────────────────────────────

describe('verifyCatalogTransitionAgainstEvidence — pending transition', () => {
  it('reports TRANSITION_PENDING (exit-0 state) with the EXACT transition values for an UNVERIFIED entry', () => {
    const evidence = buildSyntheticPassEvidence();
    const result = verifyCatalogTransitionAgainstEvidence(evidence, unverifiedEntry('oanda'));
    expect(result.status).toBe('TRANSITION_PENDING');
    expect(result.brokerId).toBe('oanda');
    expect(result.transition).toEqual({
      status: 'VERIFIED',
      verifiedAt: SYNTHETIC_FINISHED_AT,
      evidenceRef: buildCertificationCatalogEvidenceRef(evidence),
      certifiedVia: 'HARNESS_CERTIFIED',
      certificationRunRef: `${SYNTHETIC_RUN_ID}@sha256:${evidence.evidenceSha256}`,
    });
    expect(result.message).toContain('TRANSITION_PENDING');
  });

  it('reports TRANSITION_PENDING for a LEGACY_VERIFIED entry (the honest upgrade path)', () => {
    const evidence = buildSyntheticPassEvidence({ recordOverrides: { brokerId: 'metatrader5' } });
    const result = verifyCatalogTransitionAgainstEvidence(
      evidence,
      legacyVerifiedEntry('metatrader5'),
    );
    expect(result.status).toBe('TRANSITION_PENDING');
    expect(result.transition?.certifiedVia).toBe('HARNESS_CERTIFIED');
  });

  it('reports TRANSITION_PENDING for an entry with absent productionLiveVerification', () => {
    const evidence = buildSyntheticPassEvidence();
    const result = verifyCatalogTransitionAgainstEvidence(evidence, { id: 'oanda' });
    expect(result.status).toBe('TRANSITION_PENDING');
  });
});

describe('verifyCatalogTransitionAgainstEvidence — verified transition', () => {
  it('reports VERIFIED when every HARNESS_CERTIFIED field matches the artifact exactly', () => {
    const evidence = buildSyntheticPassEvidence();
    const result = verifyCatalogTransitionAgainstEvidence(
      evidence,
      harnessCertifiedEntry('oanda', evidence),
    );
    expect(result.status).toBe('VERIFIED');
    expect(result.brokerId).toBe('oanda');
    expect(result.message).toContain('VERIFIED');
  });
});

describe('verifyCatalogTransitionAgainstEvidence — fabricated or stale catalog claims', () => {
  it('errors on a certificationRunRef hash mismatch (wrong hash in the catalog)', () => {
    const evidence = buildSyntheticPassEvidence();
    const result = verifyCatalogTransitionAgainstEvidence(
      evidence,
      harnessCertifiedEntry('oanda', evidence, {
        certificationRunRef: `${SYNTHETIC_RUN_ID}@sha256:${'f'.repeat(64)}`,
      }),
    );
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain('certificationRunRef mismatch');
  });

  it('errors on a certificationRunRef run mismatch (stale run in the catalog)', () => {
    const evidence = buildSyntheticPassEvidence();
    const otherRun = '99999999-1111-4222-8333-444455556666';
    const result = verifyCatalogTransitionAgainstEvidence(
      evidence,
      harnessCertifiedEntry('oanda', evidence, {
        certificationRunRef: `${otherRun}@sha256:${evidence.evidenceSha256}`,
      }),
    );
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain('certificationRunRef mismatch');
  });

  it('errors on a verifiedAt mismatch', () => {
    const evidence = buildSyntheticPassEvidence();
    const result = verifyCatalogTransitionAgainstEvidence(
      evidence,
      harnessCertifiedEntry('oanda', evidence, { verifiedAt: '2024-01-01T00:00:00.000Z' }),
    );
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain('verifiedAt mismatch');
  });

  it('errors on an evidenceRef mismatch', () => {
    const evidence = buildSyntheticPassEvidence();
    const result = verifyCatalogTransitionAgainstEvidence(
      evidence,
      harnessCertifiedEntry('oanda', evidence, { evidenceRef: 'fabricated evidence reference' }),
    );
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain('evidenceRef mismatch');
  });
});

describe('verifyCatalogTransitionAgainstEvidence — artifact integrity', () => {
  it('errors when the recomputed evidence SHA-256 does not match the claimed hash (tampered content)', () => {
    // Tamper with content AFTER the hash was computed: the verifier's own
    // recomputation must disagree with the artifact's claim.
    const evidence = buildSyntheticPassEvidence({
      evidenceOverrides: { operatorId: 'tampered-operator' },
    });
    const result = verifyCatalogTransitionAgainstEvidence(evidence, unverifiedEntry('oanda'));
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain('SHA-256 mismatch');
  });

  it('errors when evidenceSha256 is replaced with a different well-formed hash', () => {
    const evidence = buildSyntheticPassEvidence({
      evidenceOverrides: { evidenceSha256: 'a'.repeat(64) },
    });
    const result = verifyCatalogTransitionAgainstEvidence(evidence, unverifiedEntry('oanda'));
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain('SHA-256 mismatch');
  });

  it('errors when the artifact is not a certifiable PASS (persistence failed)', () => {
    const evidence = buildSyntheticPassEvidence({
      evidenceOverrides: {
        evidenceState: 'PERSISTENCE_FAILED',
        certificationResult: 'EVIDENCE_PERSISTENCE_FAILED',
        artifactPath: undefined,
      },
    });
    const result = verifyCatalogTransitionAgainstEvidence(evidence, unverifiedEntry('oanda'));
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain('isCertifiablePass(evidence) === false');
  });

  it('errors when the artifact overall result is FAIL', () => {
    const evidence = buildSyntheticPassEvidence({ recordOverrides: { overall: 'FAIL' } });
    const result = verifyCatalogTransitionAgainstEvidence(evidence, unverifiedEntry('oanda'));
    expect(result.status).toBe('ERROR');
  });

  it('errors on a non-UUID runId', () => {
    const evidence = buildSyntheticPassEvidence({
      evidenceOverrides: { runId: 'not-a-uuid' },
    });
    const result = verifyCatalogTransitionAgainstEvidence(evidence, unverifiedEntry('oanda'));
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain('runId');
  });

  it('errors on a non-object artifact', () => {
    const result = verifyCatalogTransitionAgainstEvidence(null, unverifiedEntry('oanda'));
    expect(result.status).toBe('ERROR');
  });

  it('errors on a broker identity mismatch (one broker identity can never authorize another)', () => {
    const evidence = buildSyntheticPassEvidence();
    const result = verifyCatalogTransitionAgainstEvidence(evidence, unverifiedEntry('ctrader'));
    expect(result.status).toBe('ERROR');
    expect(result.problems?.join('\n')).toContain(
      "artifact brokerId 'oanda' !== catalog entry id 'ctrader'",
    );
  });
});

// ─── parseVerifyTransitionArgs (pure) ─────────────────────────────────────────

describe('parseVerifyTransitionArgs', () => {
  it('requires --evidence', () => {
    const args = parseVerifyTransitionArgs([]);
    expect(args.evidencePath).toBeUndefined();
    expect(args.problems.join('\n')).toContain('--evidence');
  });

  it('parses --evidence <path> and the optional --broker <id>', () => {
    const args = parseVerifyTransitionArgs([
      '--evidence',
      '/tmp/artifact.json',
      '--broker',
      'oanda',
    ]);
    expect(args.evidencePath).toBe('/tmp/artifact.json');
    expect(args.brokerId).toBe('oanda');
    expect(args.problems).toHaveLength(0);
  });

  it('parses the --evidence=<path> form and defaults brokerId to the artifact brokerId', () => {
    const args = parseVerifyTransitionArgs(['--evidence=/tmp/artifact.json']);
    expect(args.evidencePath).toBe('/tmp/artifact.json');
    expect(args.brokerId).toBeUndefined();
    expect(args.problems).toHaveLength(0);
  });

  it('rejects unknown arguments', () => {
    const args = parseVerifyTransitionArgs(['--evidence', '/tmp/a.json', '--bogus']);
    expect(args.problems.join('\n')).toContain('--bogus');
  });

  it('rejects --evidence without a value', () => {
    const args = parseVerifyTransitionArgs(['--evidence']);
    expect(args.problems.join('\n')).toContain('--evidence requires a path argument');
  });

  it('strips a pnpm-forwarded "--" argument separator before parsing flags', () => {
    const args = parseVerifyTransitionArgs(['--', '--evidence', '/tmp/artifact.json']);
    expect(args.evidencePath).toBe('/tmp/artifact.json');
    expect(args.problems).toHaveLength(0);
  });
});

// ─── Transition value builders (the shared contract between the two scripts) ─

describe('certification catalog-transition value builders', () => {
  it('builds the certificationRunRef as <runId>@sha256:<hash>', () => {
    const evidence = buildSyntheticPassEvidence();
    expect(buildCertificationRunRef(evidence)).toBe(
      `${SYNTHETIC_RUN_ID}@sha256:${evidence.evidenceSha256}`,
    );
  });

  it('builds verifiedAt from the run finishedAt and a sanitized evidenceRef naming the artifact file', () => {
    const evidence = buildSyntheticPassEvidence();
    expect(buildCertificationVerifiedAt(evidence)).toBe(SYNTHETIC_FINISHED_AT);
    const evidenceRef = buildCertificationCatalogEvidenceRef(evidence);
    expect(evidenceRef).toContain(
      `live-certification-oanda-${SYNTHETIC_RUN_ID}-20250601-100230.json`,
    );
    expect(evidenceRef).toContain('never committed');
  });
});
