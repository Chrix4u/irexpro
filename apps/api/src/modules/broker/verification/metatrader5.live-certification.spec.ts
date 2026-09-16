import {
  LiveCertificationGateDisabledError,
  buildMetaTraderCertificationHarness,
  resolveLiveCertificationGateFromEnv,
  isCertifiablePass,
  runLiveProviderCertification,
} from './provider-live-certification-harness';
import { existsSync } from 'fs';

/**
 * MetaTrader 5 PRODUCTION-LIVE certification harness — OPERATOR-ONLY,
 * ENV-GATED (Round 7, R7-impl-harness). This is the REAL-MONEY certification
 * entry point for the platform's only productionLiveVerification=VERIFIED
 * provider (re-certification path, audit R7-audit-D #4).
 *
 * HOW TO RUN (authorized operator, NEVER in CI):
 *   IREXPRO_ALLOW_LIVE_CERTIFICATION=true \
 *   IREXPRO_LIVE_CERT_OPERATOR_ID=<operator identity for the evidence record> \
 *   METAAPI_LIVE_CERT_TOKEN=<MetaAPI platform token with access to the target account> \
 *   METAAPI_LIVE_CERT_ACCOUNT_ID=<MetaAPI account UUID of the LIVE MT5 account> \
 *   METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE=<positive decimal string, quote currency,
 *     e.g. 2000 for a ~$100 margin canary on EURUSD> \
 *   [METAAPI_LIVE_CERT_INSTRUMENT=<canary instrument, default: first catalog symbol>] \
 *   [IREXPRO_LIVE_CERT_EVIDENCE_DIR=<directory for the evidence artifact>] \
 *   pnpm --filter @irexpro/api exec jest \
 *     src/modules/broker/verification/metatrader5.live-certification.spec.ts
 *
 * CI NEVER sets these variables → this suite reports as SKIPPED on every CI
 * run (the describe.skip branch): CI is credential-free AND gate-closed, so a
 * real-money certification run is structurally impossible there.
 *
 * WHAT IT DOES: builds the REAL MetaTraderAdapter + MetaApiClientService the
 * way broker.module does (buildMetaTraderCertificationHarness — the MetaApi
 * SDK is dynamically imported and torn down after the run), then drives it in
 * BrokerMode.LIVE through the full certification sequence: connect (provider
 * LIVE classification enforced), account discovery (honest skip — no
 * listAccounts surface), account state, symbol metadata, fresh price, margin
 * estimate (fail-closed when unprovable), baseline exposure snapshot, the
 * minimum-safe-order canary (provider minLot, capped by the operator's
 * explicit maxCanaryExposure — never AI-sized, never above the cap), provider
 * ack verification, order/position queries, a risk-REDUCING protective SL
 * modification, full close, closure verification, history reconciliation and
 * the zero-unexpected-open-exposure diff against the baseline.
 *
 * EVIDENCE (Round 7.1): the durable artifact is the ONLY evidence surface —
 * written + read-back hash-verified to
 * ${IREXPRO_LIVE_CERT_EVIDENCE_DIR:-.}/live-certification-metatrader5-<runId>-<timestamp>.json
 * (masked account ids, counts + masked fingerprints only — no credentials by
 * construction). The console prints a static pointer only — no env-derived
 * values are logged (CodeQL CWE-532 hygiene). That artifact is the
 * evidenceRef material for the documented operator catalog-edit +
 * provider-matrix process (docs/brokers/provider-matrix.md); the harness
 * itself NEVER flips productionLiveVerification.
 */

const gate = resolveLiveCertificationGateFromEnv();
const operatorId = process.env.IREXPRO_LIVE_CERT_OPERATOR_ID;
const metaApiToken = process.env.METAAPI_LIVE_CERT_TOKEN;
const accountId = process.env.METAAPI_LIVE_CERT_ACCOUNT_ID;
const maxCanaryExposure = process.env.METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE;
const instrument = process.env.METAAPI_LIVE_CERT_INSTRUMENT;
const evidenceDir = process.env.IREXPRO_LIVE_CERT_EVIDENCE_DIR;

const configured =
  gate.allowLiveCertification &&
  Boolean(operatorId && metaApiToken && accountId && maxCanaryExposure);

const describeMt5LiveCertification = configured ? describe : describe.skip;

describeMt5LiveCertification(
  'MetaTrader 5 LIVE certification harness (operator-run, env-gated, REAL money)',
  () => {
    it('certifies the real MetaApi LIVE account end-to-end and writes the evidence artifact', async () => {
      const built = await buildMetaTraderCertificationHarness(metaApiToken!);
      let evidence;
      try {
        evidence = await runLiveProviderCertification({
          gate,
          target: {
            brokerId: 'metatrader5',
            accountId: accountId!,
            credentialSource:
              'env:METAAPI_LIVE_CERT_TOKEN (operator-supplied MetaAPI platform token)',
          },
          operator: { operatorId: operatorId!, evidenceDir },
          maxCanaryExposure: maxCanaryExposure!,
          credentials: { accountId: accountId! },
          adapter: built.adapter,
          ...(instrument ? { instrument } : {}),
        });
      } finally {
        await built.dispose?.();
      }

      // Round 7.1 (CodeQL CWE-532 hygiene): the console is NOT an evidence
      // surface — no env-derived values are printed. The durable, read-back
      // verified artifact is the authority; the assertions below pin the
      // certifiable contract (mode, broker, result, PERSISTED state, hash).
      console.log(
        'MetaTrader 5 LIVE certification run captured — full sanitized evidence is in ' +
          'the operator evidence artifact; the assertions below pin the durable contract.',
      );

      expect(evidence.mode).toBe('LIVE');
      expect(evidence.brokerId).toBe('metatrader5');
      expect(evidence.overall).toBe('PASS');
      // Round 7.1 (P0-2): a certification PASS requires DURABLE, read-back
      // verified evidence — an ephemeral console PASS certifies nothing.
      expect(evidence.certificationResult).toBe('PASS');
      expect(evidence.evidenceState).toBe('PERSISTED');
      expect(isCertifiablePass(evidence)).toBe(true);
      expect(evidence.artifactPath).toBeDefined();
      expect(existsSync(evidence.artifactPath!)).toBe(true);
      // A certification PASS means zero failures AND the complete canary
      // lifecycle (place → close → verify-closed → zero unexpected exposure).
      expect(evidence.summary.failed).toBe(0);
      expect(evidence.summary.passed).toBeGreaterThan(0);
    }, 300_000);

    it('never includes the MetaAPI token in the sanitized evidence', async () => {
      const built = await buildMetaTraderCertificationHarness(metaApiToken!);
      let evidence;
      try {
        evidence = await runLiveProviderCertification({
          gate,
          target: {
            brokerId: 'metatrader5',
            accountId: accountId!,
            credentialSource:
              'env:METAAPI_LIVE_CERT_TOKEN (operator-supplied MetaAPI platform token)',
          },
          operator: { operatorId: operatorId!, evidenceDir },
          maxCanaryExposure: maxCanaryExposure!,
          credentials: { accountId: accountId! },
          adapter: built.adapter,
          ...(instrument ? { instrument } : {}),
        });
      } finally {
        await built.dispose?.();
      }
      expect(JSON.stringify(evidence)).not.toContain(metaApiToken!);
    });
  },
);

// Always-on gate-closed proof (the CI state): with the env gate absent the
// typed refusal fires BEFORE any provider call / adapter construction — the
// operator-run branch above stays describe.skip'd in exactly that state.
const describeMt5GateClosed = gate.allowLiveCertification ? describe.skip : describe;

describeMt5GateClosed('MetaTrader 5 LIVE certification harness (gate-closed)', () => {
  it('refuses with a typed error and zero provider calls when the env gate is not armed', async () => {
    await expect(
      runLiveProviderCertification({
        gate,
        target: {
          brokerId: 'metatrader5',
          accountId: accountId ?? 'gate-closed-row',
          credentialSource: 'env-gated spec (gate-closed row — no provider contact)',
        },
        operator: { operatorId: operatorId ?? 'gate-closed-row' },
        maxCanaryExposure: maxCanaryExposure ?? '1',
        credentials: { accountId: accountId ?? 'gate-closed-row' },
      }),
    ).rejects.toThrow(LiveCertificationGateDisabledError);
  });
});
