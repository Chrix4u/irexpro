import {
  LiveCertificationGateDisabledError,
  resolveLiveCertificationGateFromEnv,
  isCertifiablePass,
  runLiveProviderCertification,
} from './provider-live-certification-harness';
import { existsSync } from 'fs';

/**
 * OANDA PRODUCTION-LIVE certification harness — OPERATOR-ONLY, ENV-GATED
 * (Round 7, R7-impl-harness). This is the REAL-MONEY certification entry
 * point for the OANDA v20 adapter (productionLiveVerification=UNVERIFIED —
 * a PASS here is the evidence material for the documented operator
 * catalog-edit + provider-matrix process; the harness itself flips nothing).
 *
 * HOW TO RUN (authorized operator, NEVER in CI):
 *   IREXPRO_ALLOW_LIVE_CERTIFICATION=true \
 *   IREXPRO_LIVE_CERT_OPERATOR_ID=<operator identity for the evidence record> \
 *   OANDA_LIVE_CERT_TOKEN=<personal access token from the fxTrade LIVE portal
 *     — Manage API Access; environment-scoped: a practice token will FAIL> \
 *   OANDA_LIVE_CERT_ACCOUNT_ID=<e.g. 101-004-1234567-001 (a LIVE fxTrade account)> \
 *   OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE=<positive decimal string in the canary
 *     instrument's quote currency, e.g. 2000> \
 *   [OANDA_LIVE_CERT_INSTRUMENT=<canary instrument, default: first catalog symbol>] \
 *   [IREXPRO_LIVE_CERT_EVIDENCE_DIR=<directory for the evidence artifact>] \
 *   pnpm --filter @irexpro/api exec jest \
 *     src/modules/broker/verification/oanda.live-certification.spec.ts
 *
 * CI NEVER sets these variables → this suite reports as SKIPPED on every CI
 * run (the describe.skip branch): CI is credential-free AND gate-closed, so a
 * real-money certification run is structurally impossible there.
 *
 * WHAT IT DOES: drives the REAL OandaAdapter (v20 REST, environment-separated
 * base URLs — LIVE mode selects https://api-fxtrade.oanda.com) through the
 * full certification sequence: connect (LIVE classification enforced),
 * account discovery (honest skip — the adapter exposes no listAccounts),
 * account state, symbol metadata (per-instrument v20 specs), fresh price,
 * margin estimate (fail-closed when unprovable), baseline exposure snapshot,
 * the minimum-safe-order canary (provider minLot, capped by the operator's
 * explicit maxCanaryExposure — never AI-sized, never above the cap), provider
 * ack verification, order/position queries, a risk-REDUCING protective SL
 * modification, full close, closure verification, history reconciliation and
 * the zero-unexpected-open-exposure diff against the baseline.
 *
 * EVIDENCE: the sanitized evidence object is console.log'd AND written to
 * ${IREXPRO_LIVE_CERT_EVIDENCE_DIR:-.}/live-certification-oanda-<timestamp>.json
 * (masked account ids, counts + masked fingerprints only — no credentials by
 * construction). See docs/brokers/provider-matrix.md for the VERIFIED flip
 * process (operator edits BROKER_CATALOG with attested verifiedAt +
 * evidenceRef; tests never flip it).
 */
const gate = resolveLiveCertificationGateFromEnv();
const operatorId = process.env.IREXPRO_LIVE_CERT_OPERATOR_ID;
const token = process.env.OANDA_LIVE_CERT_TOKEN;
const accountId = process.env.OANDA_LIVE_CERT_ACCOUNT_ID;
const maxCanaryExposure = process.env.OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE;
const instrument = process.env.OANDA_LIVE_CERT_INSTRUMENT;
const evidenceDir = process.env.IREXPRO_LIVE_CERT_EVIDENCE_DIR;

const configured =
  gate.allowLiveCertification && Boolean(operatorId && token && accountId && maxCanaryExposure);

const describeOandaLiveCertification = configured ? describe : describe.skip;

describeOandaLiveCertification(
  'OANDA LIVE certification harness (operator-run, env-gated, REAL money)',
  () => {
    it('certifies the real fxTrade LIVE account end-to-end and writes the evidence artifact', async () => {
      const evidence = await runLiveProviderCertification({
        gate,
        target: {
          brokerId: 'oanda',
          accountId: accountId!,
          credentialSource:
            'env:OANDA_LIVE_CERT_TOKEN (operator-supplied fxTrade personal access token)',
        },
        operator: { operatorId: operatorId!, evidenceDir },
        maxCanaryExposure: maxCanaryExposure!,
        credentials: { apiKey: token!, accountId: accountId! },
        ...(instrument ? { instrument } : {}),
      });

      // Sanitized evidence — safe to print by construction (no credentials).
      console.log('OANDA LIVE certification evidence:\n', JSON.stringify(evidence, null, 2));
      console.log(
        'Evidence artifact:',
        evidence.artifactPath ?? '(NOT PERSISTED — run is not certifiable)',
      );

      expect(evidence.mode).toBe('LIVE');
      expect(evidence.brokerId).toBe('oanda');
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

    it('never includes the personal access token in the sanitized evidence', async () => {
      const evidence = await runLiveProviderCertification({
        gate,
        target: {
          brokerId: 'oanda',
          accountId: accountId!,
          credentialSource:
            'env:OANDA_LIVE_CERT_TOKEN (operator-supplied fxTrade personal access token)',
        },
        operator: { operatorId: operatorId!, evidenceDir },
        maxCanaryExposure: maxCanaryExposure!,
        credentials: { apiKey: token!, accountId: accountId! },
        ...(instrument ? { instrument } : {}),
      });
      expect(JSON.stringify(evidence)).not.toContain(token!);
    }, 300_000);
  },
);

// Always-on gate-closed proof (the CI state): with the env gate absent the
// typed refusal fires BEFORE any provider call / adapter construction — the
// operator-run branch above stays describe.skip'd in exactly that state.
const describeOandaGateClosed = gate.allowLiveCertification ? describe.skip : describe;

describeOandaGateClosed('OANDA LIVE certification harness (gate-closed)', () => {
  it('refuses with a typed error and zero provider calls when the env gate is not armed', async () => {
    await expect(
      runLiveProviderCertification({
        gate,
        target: {
          brokerId: 'oanda',
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
