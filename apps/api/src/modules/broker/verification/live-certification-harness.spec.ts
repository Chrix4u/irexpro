import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BrokerAccountInfo,
  BrokerBalance,
  BrokerCloseAllResult,
  BrokerClosedTrade,
  BrokerConnectionResult,
  BrokerConnectionTestResult,
  BrokerInstrument,
  BrokerMode,
  BrokerOrderModification,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerOrderState,
  BrokerPosition,
  BrokerPrice,
  DecryptedBrokerCredentials,
  IBrokerAdapter,
  OHLCV,
  RequiredMarginParams,
} from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import type { OrderCapabilityDeclaration } from '../interfaces/order-capability';
import { OandaAdapter } from '../adapters/oanda/oanda.adapter';
import configuration, { isLiveCertificationEnabled } from '../../../config/configuration';
import { validationSchema } from '../../../config/validation.schema';
import {
  LIVE_CANARY_SAFETY_FACTOR,
  LIVE_CERTIFICATION_STAGES,
  LiveCanaryExposureRefusalError,
  LiveCertificationConfigurationError,
  LiveCertificationGateDisabledError,
  buildLiveCertificationAdapter,
  buildMetaTraderCertificationHarness,
  computeLiveCertificationEvidenceSha256,
  deriveMinimumSafeCanarySize,
  isCertifiablePass,
  liveCertificationArtifactFileName,
  liveCertificationArtifactTimestamp,
  resolveLiveCertificationGateFromEnv,
  runLiveProviderCertification,
  verifyLiveCertificationArtifact,
} from './provider-live-certification-harness';

/**
 * LIVE certification harness — ALWAYS-ON machinery proof (Round 7,
 * R7-impl-harness).
 *
 * This suite proves the OPERATOR-ONLY REAL-MONEY certification ENGINE works
 * deterministically with a FAKE adapter: NO real provider is contacted, NO
 * environment gate is required (the gate object is injected), NO credentials
 * exist. CI stays credential-free and gate-closed — the real-provider LIVE
 * suites (metatrader5/oanda/ctrader .live-certification.spec.ts) are
 * describe.skip unless the operator sets IREXPRO_ALLOW_LIVE_CERTIFICATION
 * plus per-broker credential env vars.
 *
 * THIS IS NOT CERTIFICATION EVIDENCE: a green run here proves the machinery
 * (gates, canary sizing, stage cascade, exposure diff, evidence sanitation),
 * NOT that any provider works. The ONLY legitimate path to flipping a
 * provider's productionLiveVerification to VERIFIED remains the documented
 * operator catalog-edit + provider-matrix process (docs/brokers/provider-matrix.md).
 */
const FAKE_ACCOUNT_ID = 'fake-live-account-0001';
const CREDENTIAL_MARKER = 'FAKE_LIVE_CERT_SECRET_MARKER_9a8b7c6d5e4f';

describe('LIVE certification harness — env gate resolution (fail-closed)', () => {
  const originalValue = process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION;

  function restoreGateEnv(): void {
    if (originalValue === undefined) {
      delete process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION;
    } else {
      process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION = originalValue;
    }
  }

  afterEach(restoreGateEnv);

  it('maps ONLY the exact string true to enabled — absent, blank, false, TRUE are all disabled', () => {
    for (const value of [undefined, '', 'false', 'TRUE', 'yes', '1']) {
      if (value === undefined) {
        delete process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION;
      } else {
        process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION = value;
      }
      expect(configuration().broker.allowLiveCertification).toBe(false);
      expect(isLiveCertificationEnabled(configuration())).toBe(false);
      expect(isLiveCertificationEnabled(null)).toBe(false);
      expect(isLiveCertificationEnabled(undefined)).toBe(false);
      expect(isLiveCertificationEnabled({})).toBe(false);
      expect(isLiveCertificationEnabled({ broker: {} })).toBe(false);
    }
  });

  it('enables the gate ONLY for the exact string true (never a default-true)', () => {
    process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION = 'true';
    expect(configuration().broker.allowLiveCertification).toBe(true);
    expect(isLiveCertificationEnabled(configuration())).toBe(true);
    expect(isLiveCertificationEnabled({ broker: { allowLiveCertification: true } })).toBe(true);
  });

  it('resolves the gate object from the environment (spec entry-point path)', () => {
    delete process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION;
    expect(resolveLiveCertificationGateFromEnv()).toEqual({
      allowLiveCertification: false,
      source: 'env:IREXPRO_ALLOW_LIVE_CERTIFICATION',
    });
    process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION = 'true';
    expect(resolveLiveCertificationGateFromEnv().allowLiveCertification).toBe(true);
  });

  it('validates the env var loudly: only true/false/empty pass Joi, a typo fails boot validation', () => {
    const base: Record<string, string> = {
      NODE_ENV: 'development',
      JWT_SECRET: 'j'.repeat(32),
      DB_HOST: 'localhost',
      DB_NAME: 'irexpro_test',
      DB_USER: 'irexpro',
      DB_PASSWORD: 'database-password',
      COOKIE_SECRET: 'c'.repeat(16),
      BROKER_ENCRYPTION_KEY: 'b'.repeat(32),
    };
    for (const value of [undefined, '', 'true', 'false']) {
      const env: Record<string, string> = { ...base };
      if (value === undefined) delete env.IREXPRO_ALLOW_LIVE_CERTIFICATION;
      else env.IREXPRO_ALLOW_LIVE_CERTIFICATION = value;
      expect(validationSchema.validate(env).error).toBeUndefined();
    }
    const typo = validationSchema.validate({
      ...base,
      IREXPRO_ALLOW_LIVE_CERTIFICATION: 'ture',
    });
    expect(typo.error?.message).toContain('IREXPRO_ALLOW_LIVE_CERTIFICATION');
  });
});

describe('LIVE certification harness — certification gates (typed refusals, zero provider calls)', () => {
  let artifactsDir: string;

  beforeAll(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'live-cert-gates-'));
  });

  afterAll(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function gatedOptions(): {
    adapter: FakeLiveCertificationAdapter;
    options: Parameters<typeof runLiveProviderCertification>[0];
  } {
    const adapter = new FakeLiveCertificationAdapter();
    return {
      adapter,
      options: {
        gate: { allowLiveCertification: false, source: 'unit-test' },
        target: {
          brokerId: 'fake-live',
          accountId: FAKE_ACCOUNT_ID,
          credentialSource: 'unit-test fixture (no real credential)',
        },
        operator: { operatorId: 'unit-test-operator', evidenceDir: artifactsDir },
        maxCanaryExposure: '2000',
        credentials: { apiKey: CREDENTIAL_MARKER, accountId: FAKE_ACCOUNT_ID },
        adapter,
      },
    };
  }

  it('refuses with a typed error and ZERO provider calls when the gate is disabled', async () => {
    const { adapter, options } = gatedOptions();
    await expect(runLiveProviderCertification(options)).rejects.toThrow(
      LiveCertificationGateDisabledError,
    );
    await expect(runLiveProviderCertification(options)).rejects.toThrow(
      /IREXPRO_ALLOW_LIVE_CERTIFICATION/,
    );
    expect(adapter.calls.length).toBe(0);
  });

  it('refuses with a typed error and zero provider calls when the gate object is absent', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    await expect(
      runLiveProviderCertification({
        ...gatedOptions().options,
        gate: undefined as unknown as Parameters<typeof runLiveProviderCertification>[0]['gate'],
        adapter,
      }),
    ).rejects.toThrow(LiveCertificationGateDisabledError);
    expect(adapter.calls.length).toBe(0);
  });

  it('refuses when the operator identity is missing (gate enabled)', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    const base = gatedOptions().options;
    await expect(
      runLiveProviderCertification({
        ...base,
        gate: { allowLiveCertification: true, source: 'unit-test' },
        operator: { operatorId: '', evidenceDir: artifactsDir },
        adapter,
      }),
    ).rejects.toThrow(LiveCertificationConfigurationError);
    expect(adapter.calls.length).toBe(0);
  });

  it('refuses when the certification target is incomplete (no accountId / no credentialSource)', async () => {
    const gate = { allowLiveCertification: true, source: 'unit-test' };
    const base = gatedOptions().options;
    const noAccountId = new FakeLiveCertificationAdapter();
    await expect(
      runLiveProviderCertification({
        ...base,
        gate,
        target: { brokerId: 'fake-live', accountId: '', credentialSource: 'fixture' },
        adapter: noAccountId,
      }),
    ).rejects.toThrow(LiveCertificationConfigurationError);
    expect(noAccountId.calls.length).toBe(0);

    const noCredentialSource = new FakeLiveCertificationAdapter();
    await expect(
      runLiveProviderCertification({
        ...base,
        gate,
        target: { brokerId: 'fake-live', accountId: FAKE_ACCOUNT_ID, credentialSource: '' },
        adapter: noCredentialSource,
      }),
    ).rejects.toThrow(LiveCertificationConfigurationError);
    expect(noCredentialSource.calls.length).toBe(0);
  });

  it('refuses when credentialSource looks like credential MATERIAL, not a description', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    await expect(
      runLiveProviderCertification({
        ...gatedOptions().options,
        gate: { allowLiveCertification: true, source: 'unit-test' },
        target: {
          brokerId: 'fake-live',
          accountId: FAKE_ACCOUNT_ID,
          // 32-char hex run with letters AND digits — opaque secret shape.
          credentialSource: 'token abcdef1234567890abcdef1234567890',
        },
        adapter,
      }),
    ).rejects.toThrow(LiveCertificationConfigurationError);
    expect(adapter.calls.length).toBe(0);
  });

  it.each(['abc', '0', '-5', '10.5.2', '1e5', ''])(
    'refuses a malformed maxCanaryExposure ("%s") with zero provider calls',
    async (badCap) => {
      const adapter = new FakeLiveCertificationAdapter();
      await expect(
        runLiveProviderCertification({
          ...gatedOptions().options,
          gate: { allowLiveCertification: true, source: 'unit-test' },
          maxCanaryExposure: badCap,
          adapter,
        }),
      ).rejects.toThrow(LiveCertificationConfigurationError);
      expect(adapter.calls.length).toBe(0);
    },
  );

  it('refuses when credentials are missing', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    await expect(
      runLiveProviderCertification({
        ...gatedOptions().options,
        gate: { allowLiveCertification: true, source: 'unit-test' },
        credentials: undefined as unknown as DecryptedBrokerCredentials,
        adapter,
      }),
    ).rejects.toThrow(LiveCertificationConfigurationError);
    expect(adapter.calls.length).toBe(0);
  });
});

describe('LIVE certification harness — minimum-safe-order canary sizing (gate 3 policy)', () => {
  const sizingBase = {
    providerMinimum: '0.01',
    lotStep: '0.01',
    contractSize: '100000',
    referencePrice: '1.08420',
  };

  it('hardcodes the safety factor at 1 — the canary is EXACTLY the provider minimum (never AI-sized)', () => {
    expect(LIVE_CANARY_SAFETY_FACTOR).toBe(1n);
  });

  it('derives the canary at the provider minimum, capped by the operator exposure cap (exact decimal strings)', () => {
    // Cap 2000 in the quote currency → 2000 / (100000 × 1.08420) = 0.01844…
    // lots → floored to whole 0.01 lot steps → derivedLotCap 0.01.
    const sizing = deriveMinimumSafeCanarySize({ ...sizingBase, maxCanaryExposure: '2000' });
    expect(sizing.requestedSize).toBe('0.01');
    expect(sizing.derivedLotCap).toBe('0.01');
    expect(sizing.actualSize).toBe('0.01');
  });

  it('caps a generous operator limit down to whole lot steps and still uses the provider minimum', () => {
    // Cap 5000 → 0.0461… lots → 4 whole 0.01 steps → derivedLotCap 0.04; the
    // canary is min(0.01, 0.04) = the provider minimum 0.01.
    const sizing = deriveMinimumSafeCanarySize({ ...sizingBase, maxCanaryExposure: '5000' });
    expect(sizing.derivedLotCap).toBe('0.04');
    expect(sizing.actualSize).toBe('0.01');
    expect(sizing.requestedSize).toBe('0.01');
  });

  it('refuses (typed) when the cap converts to less than ONE lot step', () => {
    expect(() => deriveMinimumSafeCanarySize({ ...sizingBase, maxCanaryExposure: '20' })).toThrow(
      LiveCanaryExposureRefusalError,
    );
  });

  it('refuses (typed) when the provider minimum EXCEEDS the operator cap', () => {
    // lotStep 0.001, providerMinimum 0.10, cap 500 → derivedLotCap 0.004 < 0.10.
    expect(() =>
      deriveMinimumSafeCanarySize({
        providerMinimum: '0.10',
        lotStep: '0.001',
        contractSize: '100000',
        referencePrice: '1.08420',
        maxCanaryExposure: '500',
      }),
    ).toThrow(/provider minimum 0\.10 lots exceeds the operator cap/);
  });

  it('refuses (typed) on any non-positive or malformed sizing input', () => {
    const good = { ...sizingBase, maxCanaryExposure: '2000' };
    for (const bad of [
      { ...good, maxCanaryExposure: '0' },
      { ...good, providerMinimum: 'abc' },
      { ...good, contractSize: '0' },
      { ...good, referencePrice: '-1' },
      { ...good, lotStep: '' },
    ]) {
      expect(() => deriveMinimumSafeCanarySize(bad)).toThrow(LiveCanaryExposureRefusalError);
    }
  });

  it('aborts the run with ZERO orders when the provider minimum exceeds the operator cap', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'live-cert-refusal-'));
    try {
      const adapter = new FakeLiveCertificationAdapter();
      adapter.minLot = '0.10';
      adapter.lotStep = '0.001';
      await expect(
        runLiveProviderCertification({
          gate: { allowLiveCertification: true, source: 'unit-test' },
          target: {
            brokerId: 'fake-live',
            accountId: FAKE_ACCOUNT_ID,
            credentialSource: 'unit-test fixture (no real credential)',
          },
          operator: { operatorId: 'unit-test-operator', evidenceDir: artifactsDir },
          maxCanaryExposure: '5000',
          credentials: { apiKey: CREDENTIAL_MARKER, accountId: FAKE_ACCOUNT_ID },
          adapter,
        }),
      ).rejects.toThrow(LiveCanaryExposureRefusalError);
      // Read-only provider calls happened (connect/state/metadata/price) but
      // ZERO orders were placed and the account is untouched.
      expect(adapter.calls).toContain('connect');
      expect(adapter.calls).not.toContain('placeOrder');
      expect(adapter.openPositionCount()).toBe(0);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe('LIVE certification harness — LIVE classification enforcement (gate 4)', () => {
  let artifactsDir: string;

  beforeAll(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'live-cert-classification-'));
  });

  afterAll(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function liveGateOptions(adapter: FakeLiveCertificationAdapter) {
    return {
      gate: { allowLiveCertification: true, source: 'unit-test' },
      target: {
        brokerId: 'fake-live',
        accountId: FAKE_ACCOUNT_ID,
        credentialSource: 'unit-test fixture (no real credential)',
      },
      operator: { operatorId: 'unit-test-operator', evidenceDir: artifactsDir },
      maxCanaryExposure: '2000',
      credentials: { apiKey: CREDENTIAL_MARKER, accountId: FAKE_ACCOUNT_ID },
      adapter,
    };
  }

  it('FAILS immediately (and places ZERO orders) when connect() reports a DEMO account', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    adapter.classification = BrokerMode.DEMO;
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('FAIL');
    const connect = evidence.steps.find((s) => s.name === 'connect');
    expect(connect?.status).toBe('FAIL');
    expect(connect?.detail).toContain('DEMO account under a LIVE certification');
    // Fail-closed cascade: every other stage skipped, no canary, zero orders.
    expect(evidence.steps.filter((s) => s.status === 'SKIPPED')).toHaveLength(
      LIVE_CERTIFICATION_STAGES.length - 1,
    );
    expect(evidence.steps.every((s) => s.status !== 'PASS')).toBe(true);
    expect(evidence.canary).toBeUndefined();
    expect(adapter.calls).not.toContain('placeOrder');
    expect(adapter.openPositionCount()).toBe(0);
  });

  it('FAILS immediately when the account-state classification re-check observes DEMO (testConnection surface)', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    adapter.classification = BrokerMode.LIVE;
    adapter.testConnectionClassification = BrokerMode.DEMO;
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('FAIL');
    const accountState = evidence.steps.find((s) => s.name === 'account-state');
    expect(accountState?.status).toBe('FAIL');
    expect(accountState?.detail).toContain('LIVE certification requires a LIVE-classified account');
    // The canary is never placed on a DEMO-classified account.
    const place = evidence.steps.find((s) => s.name === 'place-minimum-safe-order');
    expect(place?.status).toBe('SKIPPED');
    expect(adapter.calls).not.toContain('placeOrder');
    expect(adapter.openPositionCount()).toBe(0);
  });
});

describe('LIVE certification harness — full machinery (fake LIVE adapter, always-on)', () => {
  let artifactsDir: string;

  beforeAll(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'live-cert-happy-'));
  });

  afterAll(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function liveGateOptions(
    adapter: FakeLiveCertificationAdapter,
    overrides: { maxCanaryExposure?: string; instrument?: string } = {},
  ) {
    return {
      gate: { allowLiveCertification: true, source: 'unit-test' },
      target: {
        brokerId: 'fake-live',
        accountId: FAKE_ACCOUNT_ID,
        credentialSource: 'unit-test fixture (no real credential)',
      },
      operator: { operatorId: 'unit-test-operator', evidenceDir: artifactsDir },
      maxCanaryExposure: overrides.maxCanaryExposure ?? '2000',
      credentials: { apiKey: CREDENTIAL_MARKER, accountId: FAKE_ACCOUNT_ID },
      adapter,
      ...(overrides.instrument ? { instrument: overrides.instrument } : {}),
    };
  }

  it('drives the full certification sequence against a fake LIVE adapter and passes deterministically', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('PASS');
    expect(evidence.mode).toBe('LIVE');
    expect(evidence.brokerId).toBe('fake-live');
    expect(evidence.operatorId).toBe('unit-test-operator');
    // Every canonical stage ran, in order — the only honest skip is the
    // account-discovery surface the fake does not implement.
    expect(evidence.steps.map((s) => s.name)).toEqual([...LIVE_CERTIFICATION_STAGES]);
    expect(evidence.steps.filter((s) => s.status === 'SKIPPED').map((s) => s.name)).toEqual([
      'account-discovery',
    ]);
    expect(evidence.summary).toEqual({
      passed: LIVE_CERTIFICATION_STAGES.length - 1,
      failed: 0,
      skipped: 1,
    });
    // Gate 4: the engine drove the adapter in LIVE mode.
    expect(adapter.mode).toBe(BrokerMode.LIVE);
    // The canary: provider minimum, capped, exact decimal strings.
    expect(evidence.canary).toEqual({
      instrument: 'EURUSD',
      requestedSize: '0.01',
      providerMinimum: '0.01',
      cap: { maxCanaryExposure: '2000', derivedLotCap: '0.01' },
      actualSize: '0.01',
      direction: 'BUY',
    });
    // The canary was really placed and really closed — no residue.
    expect(adapter.openPositionCount()).toBe(0);
    expect(evidence.baselineExposure).toEqual({
      capturedAt: expect.any(String),
      positions: { count: 0, maskedIds: [] },
      workingOrders: { count: 0, maskedIds: [] },
    });
    expect(evidence.postExposure?.positions.count).toBe(0);
    const zeroExposure = evidence.steps.find(
      (s) => s.name === 'verify-zero-unexpected-open-exposure',
    );
    expect(zeroExposure?.status).toBe('PASS');
    expect(zeroExposure?.detail).toContain('zero unexpected open exposure');
  });

  it('writes the durable evidence artifact (sanitized), read-back verifies it, and certifies PASS with a runId + hash reference', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    // Round 7.1 (P0-2): a passing checklist + durable verified evidence.
    expect(evidence.overall).toBe('PASS');
    expect(evidence.certificationResult).toBe('PASS');
    expect(evidence.evidenceState).toBe('PERSISTED');
    expect(isCertifiablePass(evidence)).toBe(true);
    // Run identity: a UUID, embedded in the evidence and the artifact name.
    expect(evidence.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(evidence.artifactPath).toBeDefined();
    const fileName = evidence.artifactPath!.split('/').pop()!;
    expect(fileName).toBe(
      `live-certification-fake-live-${evidence.runId}-${liveCertificationArtifactTimestamp(
        new Date(evidence.finishedAt),
      )}.json`,
    );
    expect(existsSync(evidence.artifactPath!)).toBe(true);
    const written = JSON.parse(readFileSync(evidence.artifactPath!, 'utf8')) as unknown;
    // The durable artifact carries the sanitized evidence — no credentials.
    expect(JSON.stringify(written)).not.toContain(CREDENTIAL_MARKER);
    expect(JSON.stringify(written)).not.toContain(FAKE_ACCOUNT_ID);
    expect((written as { mode?: string }).mode).toBe('LIVE');
    // The evidence hash is a sha256 hex digest and read-back verification
    // passes against the artifact on disk.
    expect(evidence.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLiveCertificationArtifact(evidence.artifactPath!, evidence)).toBe(true);
  });

  it('never leaks credential material or the raw account id into the sanitized evidence', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(CREDENTIAL_MARKER);
    // The target account id appears ONLY masked (maskAccountIdForLog pattern).
    expect(serialized).not.toContain(FAKE_ACCOUNT_ID);
    expect(evidence.target.accountIdMasked).toBe('•••0001');
  });

  it('FAILS the account-state stage when a provider money field is a JavaScript number', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    adapter.leakFloatMoney = true;
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('FAIL');
    const accountState = evidence.steps.find((s) => s.name === 'account-state');
    expect(accountState?.status).toBe('FAIL');
    expect(accountState?.detail).toContain('balance must be a decimal string — received number');
    expect(adapter.calls).not.toContain('placeOrder');
  });

  it('FAILS closed (zero orders) when the required margin is unprovable (null)', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    adapter.marginNull = true;
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('FAIL');
    const margin = evidence.steps.find((s) => s.name === 'margin-estimate');
    expect(margin?.status).toBe('FAIL');
    expect(margin?.detail).toContain('returned null');
    const place = evidence.steps.find((s) => s.name === 'place-minimum-safe-order');
    expect(place?.status).toBe('SKIPPED');
    expect(adapter.calls).not.toContain('placeOrder');
  });

  it('keeps attempting the canary close and FAILS critically when the position survives (real-money safety)', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    adapter.failClose = true;
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('FAIL');
    expect(evidence.steps.find((s) => s.name === 'close-position')?.status).toBe('FAIL');
    expect(evidence.steps.find((s) => s.name === 'verify-closed')?.status).toBe('SKIPPED');
    // The still-open canary surfaces as CRITICAL unexpected exposure.
    const zeroExposure = evidence.steps.find(
      (s) => s.name === 'verify-zero-unexpected-open-exposure',
    );
    expect(zeroExposure?.status).toBe('FAIL');
    expect(zeroExposure?.detail).toContain('CRITICAL: unexpected open exposure');
  });

  it('detects an unexpected EXTRA position after the close (second-run drift fixture → CRITICAL FAIL)', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    adapter.revealUnexpectedPositionAfterClose = true;
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('FAIL');
    const zeroExposure = evidence.steps.find(
      (s) => s.name === 'verify-zero-unexpected-open-exposure',
    );
    expect(zeroExposure?.status).toBe('FAIL');
    expect(zeroExposure?.detail).toContain('CRITICAL: unexpected open exposure');
    expect(zeroExposure?.detail).toContain('•••-777');
    // The unexpected position is visible in the post fingerprint (count only).
    expect(evidence.postExposure?.positions.count).toBe(1);
  });

  it('detects an unexpected EXTRA working order after the close (CRITICAL FAIL)', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    adapter.revealUnexpectedOrderAfterClose = true;
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('FAIL');
    const zeroExposure = evidence.steps.find(
      (s) => s.name === 'verify-zero-unexpected-open-exposure',
    );
    expect(zeroExposure?.status).toBe('FAIL');
    expect(zeroExposure?.detail).toContain('CRITICAL: unexpected open exposure');
    expect(evidence.postExposure?.workingOrders.count).toBe(1);
  });

  it('passes the baseline diff when a PRE-EXISTING position stays untouched (identical-state diff)', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    adapter.preExistingPositionId = 'pre-existing-9001';
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('PASS');
    expect(evidence.baselineExposure?.positions.count).toBe(1);
    expect(evidence.baselineExposure?.positions.maskedIds).toEqual(['•••9001']);
    expect(evidence.postExposure?.positions.count).toBe(1);
    expect(
      evidence.steps.find((s) => s.name === 'verify-zero-unexpected-open-exposure')?.status,
    ).toBe('PASS');
  });

  it('refuses an operator-requested canary instrument absent from the provider catalog', async () => {
    const adapter = new FakeLiveCertificationAdapter();
    const evidence = await runLiveProviderCertification(
      liveGateOptions(adapter, { instrument: 'ZZZNOTACURRENCY' }),
    );

    expect(evidence.overall).toBe('FAIL');
    const metadata = evidence.steps.find((s) => s.name === 'symbol-metadata');
    expect(metadata?.status).toBe('FAIL');
    expect(metadata?.detail).toContain('ZZZNOTACURRENCY');
    expect(adapter.calls).not.toContain('placeOrder');
  });

  it('PASSes account-discovery when the adapter enumerates the target account', async () => {
    const adapter = new FakeDiscoveryCertificationAdapter();
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('PASS');
    const discovery = evidence.steps.find((s) => s.name === 'account-discovery');
    expect(discovery?.status).toBe('PASS');
    expect(discovery?.detail).toContain('present among 2 discoverable account(s)');
    // No skips at all: every stage applicable to this adapter passed.
    expect(evidence.summary).toEqual({
      passed: LIVE_CERTIFICATION_STAGES.length,
      failed: 0,
      skipped: 0,
    });
    expect(adapter.openPositionCount()).toBe(0);
  });

  it('FAILS account-discovery (and refuses the canary) when the target is not enumerable', async () => {
    const adapter = new FakeDiscoveryCertificationAdapter();
    adapter.discoveredAccountIds = ['some-other-account-9999'];
    const evidence = await runLiveProviderCertification(liveGateOptions(adapter));

    expect(evidence.overall).toBe('FAIL');
    const discovery = evidence.steps.find((s) => s.name === 'account-discovery');
    expect(discovery?.status).toBe('FAIL');
    expect(discovery?.detail).toContain('not present among 1 discoverable account(s)');
    // Fail-closed: the discovery contradiction blocks the real-money canary.
    const place = evidence.steps.find((s) => s.name === 'place-minimum-safe-order');
    expect(place?.status).toBe('SKIPPED');
    expect(adapter.calls).not.toContain('placeOrder');
    expect(adapter.openPositionCount()).toBe(0);
  });
});

// ─── Round 7.1 (P0-2): PASS requires DURABLE evidence ────────────────────────

describe('LIVE certification harness — Round 7.1 P0-2: durable-evidence finalization (fail-closed)', () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'live-cert-p02-'));
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function liveGateOptions(
    adapter: FakeLiveCertificationAdapter,
    overrides: { evidenceDir?: string } = {},
  ) {
    return {
      gate: { allowLiveCertification: true, source: 'unit-test' },
      target: {
        brokerId: 'fake-live',
        accountId: FAKE_ACCOUNT_ID,
        credentialSource: 'unit-test fixture (no real credential)',
      },
      operator: {
        operatorId: 'unit-test-operator',
        evidenceDir: overrides.evidenceDir ?? artifactsDir,
      },
      maxCanaryExposure: '2000',
      credentials: { apiKey: CREDENTIAL_MARKER, accountId: FAKE_ACCOUNT_ID },
      adapter,
    };
  }

  it('a PASSING checklist with an UNWRITABLE evidence dir can NEVER certify — EVIDENCE_PERSISTENCE_FAILED, not PASS', async () => {
    // Adversarial setup: the evidence "directory" is a FILE — every artifact
    // write beneath it fails with ENOTDIR.
    const notADir = join(artifactsDir, 'evidence.json');
    writeFileSync(notADir, 'occupied', 'utf8');
    const unwritableDir = join(notADir, 'sub');

    const adapter = new FakeLiveCertificationAdapter();
    const evidence = await runLiveProviderCertification(
      liveGateOptions(adapter, { evidenceDir: unwritableDir }),
    );

    // The checklist itself passed — but that is NOT a certification.
    expect(evidence.overall).toBe('PASS');
    // The explicit fail-closed state: no durable evidence, no PASS.
    expect(evidence.certificationResult).toBe('EVIDENCE_PERSISTENCE_FAILED');
    expect(evidence.evidenceState).toBe('PERSISTENCE_FAILED');
    expect(evidence.artifactPath).toBeUndefined();
    expect(isCertifiablePass(evidence)).toBe(false);
  });

  it("a PASSING checklist with a NONEXISTENT evidence dir can never certify either (typo'd IREXPRO_LIVE_CERT_EVIDENCE_DIR)", async () => {
    const adapter = new FakeLiveCertificationAdapter();
    const evidence = await runLiveProviderCertification(
      liveGateOptions(adapter, { evidenceDir: join(artifactsDir, 'does-not-exist') }),
    );

    expect(evidence.overall).toBe('PASS');
    expect(evidence.certificationResult).toBe('EVIDENCE_PERSISTENCE_FAILED');
    expect(evidence.evidenceState).toBe('PERSISTENCE_FAILED');
    expect(isCertifiablePass(evidence)).toBe(false);
  });

  it('a FAILING checklist with a persistence failure reports EVIDENCE_PERSISTENCE_FAILED as the top-line result (overall retains the FAIL detail)', async () => {
    const notADir = join(artifactsDir, 'occupied.json');
    writeFileSync(notADir, 'occupied', 'utf8');

    const adapter = new FakeLiveCertificationAdapter();
    adapter.classification = BrokerMode.DEMO; // checklist fails at connect
    const evidence = await runLiveProviderCertification(
      liveGateOptions(adapter, { evidenceDir: join(notADir, 'sub') }),
    );

    expect(evidence.overall).toBe('FAIL');
    expect(evidence.certificationResult).toBe('EVIDENCE_PERSISTENCE_FAILED');
    expect(evidence.evidenceState).toBe('PERSISTENCE_FAILED');
    expect(isCertifiablePass(evidence)).toBe(false);
  });

  it('two runs in the SAME UTC second produce DISTINCT artifacts (runId namespacing — no silent overwrite)', async () => {
    const first = await runLiveProviderCertification(
      liveGateOptions(new FakeLiveCertificationAdapter()),
    );
    const second = await runLiveProviderCertification(
      liveGateOptions(new FakeLiveCertificationAdapter()),
    );

    expect(first.runId).not.toBe(second.runId);
    expect(first.artifactPath).toBeDefined();
    expect(second.artifactPath).toBeDefined();
    expect(first.artifactPath!).not.toBe(second.artifactPath!);
    // Even when finishedAt lands in the same second, the runId differentiates.
    expect(
      liveCertificationArtifactFileName('fake-live', first.runId, new Date(first.finishedAt)),
    ).not.toBe(
      liveCertificationArtifactFileName('fake-live', second.runId, new Date(second.finishedAt)),
    );
    expect(existsSync(first.artifactPath!)).toBe(true);
    expect(existsSync(second.artifactPath!)).toBe(true);
  });

  it('read-back verification detects a TAMPERED artifact (hash mismatch ⇒ not certifiable)', async () => {
    const evidence = await runLiveProviderCertification(
      liveGateOptions(new FakeLiveCertificationAdapter()),
    );
    expect(isCertifiablePass(evidence)).toBe(true);

    // Tamper: flip the recorded canary size on disk.
    const raw = JSON.parse(readFileSync(evidence.artifactPath!, 'utf8')) as {
      canary: { actualSize: string };
    };
    raw.canary.actualSize = '999.99';
    writeFileSync(evidence.artifactPath!, JSON.stringify(raw, null, 2), 'utf8');

    expect(verifyLiveCertificationArtifact(evidence.artifactPath!, evidence)).toBe(false);
    // The in-memory hash still matches the UNTAMPERED content — the
    // verification compares it against the (now different) artifact.
    expect(evidence.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the canonical evidence hash is stable across serialization round-trips (record → artifact → re-parse)', async () => {
    const evidence = await runLiveProviderCertification(
      liveGateOptions(new FakeLiveCertificationAdapter()),
    );
    const parsed = JSON.parse(readFileSync(evidence.artifactPath!, 'utf8'));

    expect(computeLiveCertificationEvidenceSha256(parsed)).toBe(evidence.evidenceSha256);
    // And the durability fields are excluded from the canonical content: the
    // hash of the run record equals the hash of the full evidence.
    expect(computeLiveCertificationEvidenceSha256(evidence)).toBe(evidence.evidenceSha256);
  });

  it('isCertifiablePass fails closed on every durability violation (not just certificationResult)', async () => {
    const evidence = await runLiveProviderCertification(
      liveGateOptions(new FakeLiveCertificationAdapter()),
    );
    expect(isCertifiablePass(evidence)).toBe(true);

    expect(isCertifiablePass({ ...evidence, evidenceState: 'PERSISTENCE_FAILED' })).toBe(false);
    expect(
      isCertifiablePass({ ...evidence, certificationResult: 'EVIDENCE_PERSISTENCE_FAILED' }),
    ).toBe(false);
    expect(isCertifiablePass({ ...evidence, certificationResult: 'FAIL' })).toBe(false);
    expect(isCertifiablePass({ ...evidence, overall: 'FAIL' })).toBe(false);
    expect(isCertifiablePass({ ...evidence, artifactPath: undefined })).toBe(false);
    expect(isCertifiablePass({ ...evidence, artifactPath: '' })).toBe(false);
    expect(isCertifiablePass({ ...evidence, evidenceSha256: 'not-a-hash' })).toBe(false);
  });
});

describe('LIVE certification harness — artifact + adapter factory discipline', () => {
  it('renders the artifact timestamp segment as UTC YYYYMMDD-HHmmss', () => {
    expect(liveCertificationArtifactTimestamp(new Date(Date.UTC(2025, 0, 2, 3, 4, 5)))).toBe(
      '20250102-030405',
    );
  });

  it('builds the REAL OANDA adapter (LIVE base URL selected later by engine mode) and refuses paper-broker', async () => {
    const built = await buildLiveCertificationAdapter('oanda');
    expect(built.adapter).toBeInstanceOf(OandaAdapter);
    expect(built.dispose).toBeUndefined();

    await expect(buildLiveCertificationAdapter('paper-broker')).rejects.toThrow(
      LiveCertificationConfigurationError,
    );
    await expect(buildLiveCertificationAdapter('unknown-broker')).rejects.toThrow(
      /No LIVE certification adapter factory/,
    );
  });

  it('refuses the MetaTrader certification factory without a platform token (typed, no SDK load)', async () => {
    const originalCertToken = process.env.METAAPI_LIVE_CERT_TOKEN;
    const originalPlatformToken = process.env.METAAPI_TOKEN;
    delete process.env.METAAPI_LIVE_CERT_TOKEN;
    delete process.env.METAAPI_TOKEN;
    try {
      await expect(buildMetaTraderCertificationHarness()).rejects.toThrow(
        LiveCertificationConfigurationError,
      );
    } finally {
      if (originalCertToken !== undefined) process.env.METAAPI_LIVE_CERT_TOKEN = originalCertToken;
      if (originalPlatformToken !== undefined) process.env.METAAPI_TOKEN = originalPlatformToken;
    }
  });
});

// ─── Fake LIVE adapter (fixture style: paper.harness.spec.ts) ─────────────────

/**
 * Deterministic in-memory IBrokerAdapter standing in for a REAL LIVE
 * provider. No network, no secrets, no time-dependence: the full
 * place → modify → close lifecycle is simulated with decimal-string money and
 * a provider-call log so specs can assert ZERO provider calls / ZERO orders.
 */
class FakeLiveCertificationAdapter implements IBrokerAdapter {
  readonly brokerId = 'fake-live';
  readonly brokerName = 'Fake LIVE provider (certification machinery proof)';
  readonly supportsDemo = true;

  /** Provider-call log — the zero-provider-calls / zero-orders assertions. */
  readonly calls: string[] = [];
  /** The mode the ENGINE set (gate 4 proof). */
  mode: BrokerMode = BrokerMode.DEMO;
  /** Provider-observed account classification for connect(). */
  classification: BrokerMode.LIVE | BrokerMode.DEMO = BrokerMode.LIVE;
  /** Overrides the classification observed by testConnection() (account-state re-check). */
  testConnectionClassification?: BrokerMode.LIVE | BrokerMode.DEMO;
  minLot = '0.01';
  lotStep = '0.01';
  contractSize = '100000';
  /** When set, a foreign position appears in post-close position reads. */
  revealUnexpectedPositionAfterClose = false;
  /** When set, a foreign working order appears in post-close listOrders(). */
  revealUnexpectedOrderAfterClose = false;
  /** Pre-existing (baseline) position id, present in EVERY position read. */
  preExistingPositionId: string | null = null;
  /** When set, closeOrder() reports failure (the canary stays open). */
  failClose = false;
  /** When set, getAccountInfo() leaks float money (decimal-string violation). */
  leakFloatMoney = false;
  /** When set, getRequiredMargin() returns null (unprovable margin). */
  marginNull = false;

  private readonly positions = new Map<string, BrokerPosition>();
  private readonly orderStates = new Map<string, BrokerOrderState>();
  private readonly closedTrades: BrokerClosedTrade[] = [];
  private nextId = 1;
  private canaryClosedOnce = false;

  openPositionCount(): number {
    return this.positions.size;
  }

  private foreignPosition(): BrokerPosition {
    return {
      externalOrderId: 'foreign-position-777',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.10',
      openPrice: '1.08000',
      currentPrice: '1.08400',
      stopLoss: '0',
      takeProfit: '0',
      unrealisedPnl: '4.00',
      openedAt: new Date(),
      commission: '0.00',
      swap: '0.00',
    };
  }

  private foreignOrder(): BrokerOrderState {
    return {
      providerOrderId: 'foreign-order-888',
      status: 'WORKING',
      instrument: 'EURUSD',
      direction: 'BUY',
      requestedQuantity: '0.10',
      filledQuantity: '0.00',
      orderKind: 'LIMIT',
      limitPrice: '1.05000',
      placedAt: new Date(),
    };
  }

  private preExistingPosition(): BrokerPosition {
    return {
      externalOrderId: this.preExistingPositionId!,
      instrument: 'EURUSD',
      direction: 'SELL',
      lotSize: '0.05',
      openPrice: '1.09000',
      currentPrice: '1.08400',
      stopLoss: '0',
      takeProfit: '0',
      unrealisedPnl: '3.00',
      openedAt: new Date(Date.now() - 3_600_000),
      commission: '0.00',
      swap: '0.00',
    };
  }

  private currentPositions(): BrokerPosition[] {
    const all = [...this.positions.values()];
    if (this.preExistingPositionId) all.push(this.preExistingPosition());
    if (this.canaryClosedOnce && this.revealUnexpectedPositionAfterClose) {
      all.push(this.foreignPosition());
    }
    return all;
  }

  setMode(mode: BrokerMode): void {
    this.mode = mode;
  }

  async connect(): Promise<BrokerConnectionResult> {
    this.calls.push('connect');
    return {
      success: true,
      accountId: FAKE_ACCOUNT_ID,
      accountType: this.classification,
      currency: 'USD',
      serverTime: new Date(),
    };
  }

  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
  }

  async testConnection(): Promise<BrokerConnectionTestResult> {
    this.calls.push('testConnection');
    return {
      success: true,
      accountId: FAKE_ACCOUNT_ID,
      accountType: this.testConnectionClassification ?? this.classification,
      currency: 'USD',
    };
  }

  isConnected(): boolean {
    return true;
  }

  async getAccountInfo(): Promise<BrokerAccountInfo> {
    this.calls.push('getAccountInfo');
    const info: BrokerAccountInfo = {
      accountId: FAKE_ACCOUNT_ID,
      currency: 'USD',
      leverage: 100,
      balance: '10000.50',
      equity: '10000.50',
      margin: '0.00',
      freeMargin: '10000.00',
      marginLevel: '0.00',
    };
    if (this.leakFloatMoney) {
      // Exactly the float-money contract violation the harness exists to catch.
      return { ...info, balance: 10000.5 } as unknown as BrokerAccountInfo;
    }
    return info;
  }

  async getAccountBalance(): Promise<BrokerBalance> {
    this.calls.push('getAccountBalance');
    return {
      balance: '10000.50',
      equity: '10000.50',
      currency: 'USD',
      timestamp: new Date(),
    };
  }

  async getOpenPositions(): Promise<BrokerPosition[]> {
    this.calls.push('getOpenPositions');
    return this.currentPositions();
  }

  async getPositionById(externalOrderId: string): Promise<BrokerPosition | null> {
    this.calls.push('getPositionById');
    return this.positions.get(externalOrderId) ?? null;
  }

  async getRequiredMargin(params: RequiredMarginParams): Promise<string | null> {
    this.calls.push('getRequiredMargin');
    void params;
    return this.marginNull ? null : '10.84';
  }

  getOrderCapabilities(): OrderCapabilityDeclaration {
    return {
      brokerId: this.brokerId,
      supportedOrderKinds: ['MARKET'],
      requirements: {
        MARKET: { limitPriceRequired: false, stopPriceRequired: false },
        LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
        STOP: { limitPriceRequired: false, stopPriceRequired: true },
        STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
      },
      marketSlTpAttachedAtPlacement: false,
    };
  }

  async getInstrumentList(): Promise<BrokerInstrument[]> {
    this.calls.push('getInstrumentList');
    return [
      {
        symbol: 'EURUSD',
        description: 'Euro vs US Dollar',
        digits: 5,
        minLot: this.minLot,
        maxLot: '100.00',
        lotStep: this.lotStep,
        contractSize: this.contractSize,
      },
    ];
  }

  async getCurrentPrice(instrument: string): Promise<BrokerPrice> {
    this.calls.push('getCurrentPrice');
    return {
      instrument,
      bid: '1.08400',
      ask: '1.08420',
      spread: '0.00020',
      timestamp: new Date(),
    };
  }

  async getOHLCV(instrument: string, timeframe: string, count: number): Promise<OHLCV[]> {
    this.calls.push('getOHLCV');
    void instrument;
    void timeframe;
    void count;
    return [];
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult> {
    this.calls.push('placeOrder');
    if (order.orderKind && order.orderKind !== 'MARKET') {
      throw new BrokerAdapterError(
        BrokerErrorCode.INVALID_ORDER_TYPE,
        `fake-live supports MARKET orders only (received ${order.orderKind})`,
      );
    }
    const externalOrderId = `fake-live-order-${this.nextId++}`;
    const filledPrice = '1.08420';
    this.positions.set(externalOrderId, {
      externalOrderId,
      instrument: order.instrument,
      direction: order.direction,
      lotSize: order.lotSize,
      openPrice: filledPrice,
      currentPrice: '1.08410',
      stopLoss: '0',
      takeProfit: '0',
      unrealisedPnl: '-0.10',
      openedAt: new Date(),
      commission: '0.00',
      swap: '0.00',
    });
    this.orderStates.set(externalOrderId, {
      providerOrderId: externalOrderId,
      clientOrderId: order.clientOrderId ?? null,
      status: 'FILLED',
      instrument: order.instrument,
      direction: order.direction,
      requestedQuantity: order.lotSize,
      filledQuantity: order.lotSize,
      avgFillPrice: filledPrice,
      orderKind: 'MARKET',
      placedAt: new Date(),
      updatedAt: new Date(),
    });
    return {
      success: true,
      externalOrderId,
      filledPrice,
      filledQuantity: order.lotSize,
      filledAt: new Date(),
      status: 'FILLED',
    };
  }

  async modifyOrder(
    externalOrderId: string,
    modifications: BrokerOrderModification,
  ): Promise<BrokerOrderResult> {
    this.calls.push('modifyOrder');
    const position = this.positions.get(externalOrderId);
    if (!position) {
      throw new BrokerAdapterError(
        BrokerErrorCode.POSITION_NOT_FOUND,
        `fake-live has no open position ${externalOrderId}`,
      );
    }
    if (modifications.newStopLoss) position.stopLoss = modifications.newStopLoss;
    return { success: true, externalOrderId, status: 'FILLED' };
  }

  async closeOrder(externalOrderId: string): Promise<BrokerOrderResult> {
    this.calls.push('closeOrder');
    if (this.failClose) {
      return { success: false, status: 'FAILED', brokerMessage: 'injected close failure' };
    }
    const position = this.positions.get(externalOrderId);
    if (!position) {
      throw new BrokerAdapterError(
        BrokerErrorCode.POSITION_NOT_FOUND,
        `fake-live has no open position ${externalOrderId}`,
      );
    }
    this.positions.delete(externalOrderId);
    this.canaryClosedOnce = true;
    this.closedTrades.push({
      externalOrderId,
      instrument: position.instrument,
      direction: position.direction,
      lotSize: position.lotSize,
      openPrice: position.openPrice,
      closePrice: '1.08410',
      stopLoss: position.stopLoss,
      takeProfit: '0',
      realisedPnl: '-0.10',
      openedAt: position.openedAt,
      closedAt: new Date(),
      commission: '0.00',
      swap: '0.00',
      closeReason: 'MANUAL',
    });
    return { success: true, externalOrderId, status: 'FILLED' };
  }

  async closeAllOrders(): Promise<BrokerCloseAllResult> {
    this.calls.push('closeAllOrders');
    return { closedCount: 0, failedCount: 0, errors: [] };
  }

  async getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]> {
    this.calls.push('getClosedTrades');
    return this.closedTrades.filter(
      (t) => t.closedAt.getTime() >= from.getTime() && t.closedAt.getTime() <= to.getTime(),
    );
  }

  async listOrders(): Promise<BrokerOrderState[]> {
    this.calls.push('listOrders');
    if (this.canaryClosedOnce && this.revealUnexpectedOrderAfterClose) {
      return [this.foreignOrder()];
    }
    return [];
  }

  async getOrderById(providerOrderId: string): Promise<BrokerOrderState | null> {
    this.calls.push('getOrderById');
    return this.orderStates.get(providerOrderId) ?? null;
  }
}

/**
 * Discovery-capable variant of the fake: exposes the OPTIONAL listAccounts()
 * surface (structurally narrowed by the engine's hasAccountDiscovery) so the
 * ACCOUNT_DISCOVERY stage runs its PASS/FAIL paths deterministically.
 */
class FakeDiscoveryCertificationAdapter extends FakeLiveCertificationAdapter {
  discoveredAccountIds: string[] = [FAKE_ACCOUNT_ID, 'another-account-0002'];

  async listAccounts(): Promise<readonly { accountId: string }[]> {
    this.calls.push('listAccounts');
    return this.discoveredAccountIds.map((accountId) => ({ accountId }));
  }
}
