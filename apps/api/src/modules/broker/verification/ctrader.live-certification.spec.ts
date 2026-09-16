import {
  LiveCertificationGateDisabledError,
  resolveLiveCertificationGateFromEnv,
  runLiveProviderCertification,
} from './provider-live-certification-harness';

/**
 * cTrader PRODUCTION-LIVE certification harness — OPERATOR-ONLY, ENV-GATED
 * (Round 7, R7-impl-harness). This is the REAL-MONEY certification entry
 * point for the cTrader family ('ctrader', 'pepperstone-ctrader',
 * 'icmarkets-ctrader' — all productionLiveVerification=UNVERIFIED; a PASS
 * here is the evidence material for the documented operator catalog-edit +
 * provider-matrix process; the harness itself flips nothing).
 *
 * HOW TO RUN (authorized operator, NEVER in CI):
 *   IREXPRO_ALLOW_LIVE_CERTIFICATION=true \
 *   IREXPRO_LIVE_CERT_OPERATOR_ID=<operator identity for the evidence record> \
 *   CTRADER_LIVE_CERT_ACCESS_TOKEN=<OAuth access token for the LIVE cTrader
 *     account (id.ctrader.com consent flow)> \
 *   CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID=<ctidTraderAccountId of the LIVE account> \
 *   CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE=<positive decimal string in the
 *     canary instrument's quote currency, e.g. 2000> \
 *   CTRADER_CLIENT_ID=<platform cTrader Open API app client id> \
 *   CTRADER_CLIENT_SECRET=<platform cTrader Open API app client secret> \
 *   [CTRADER_LIVE_CERT_BROKER_ID=<ctrader|pepperstone-ctrader|icmarkets-ctrader>] \
 *   [CTRADER_LIVE_CERT_INSTRUMENT=<canary instrument, default: first catalog symbol>] \
 *   [IREXPRO_LIVE_CERT_EVIDENCE_DIR=<directory for the evidence artifact>] \
 *   pnpm --filter @irexpro/api exec jest \
 *     src/modules/broker/verification/ctrader.live-certification.spec.ts
 *
 * CI NEVER sets these variables → this suite reports as SKIPPED on every CI
 * run (the describe.skip branch): CI is credential-free AND gate-closed, so a
 * real-money certification run is structurally impossible there.
 *
 * WHAT IT DOES: builds the REAL CTraderAdapter + CTraderClientService (the
 * same dynamic-import factory discipline as the DEMO harness; LIVE mode
 * selects wss://live.ctraderapi.com:5036 with the adapter's connect-time
 * isLive cross-check) and drives it through the full certification sequence:
 * connect (LIVE classification enforced), account discovery (honest skip —
 * no listAccounts surface), account state, symbol metadata, fresh price,
 * margin estimate (fail-closed when unprovable), baseline exposure snapshot,
 * the minimum-safe-order canary (provider minLot, capped by the operator's
 * explicit maxCanaryExposure — never AI-sized, never above the cap), provider
 * ack verification, order/position queries, a risk-REDUCING protective SL
 * modification, full close, closure verification, history reconciliation and
 * the zero-unexpected-open-exposure diff against the baseline.
 *
 * EVIDENCE: the sanitized evidence object is console.log'd AND written to
 * ${IREXPRO_LIVE_CERT_EVIDENCE_DIR:-.}/live-certification-<brokerId>-<timestamp>.json
 * (masked account ids, counts + masked fingerprints only — no credentials by
 * construction). See docs/brokers/provider-matrix.md for the VERIFIED flip
 * process (operator edits BROKER_CATALOG with attested verifiedAt +
 * evidenceRef; tests never flip it).
 */
const gate = resolveLiveCertificationGateFromEnv();
const operatorId = process.env.IREXPRO_LIVE_CERT_OPERATOR_ID;
const accessToken = process.env.CTRADER_LIVE_CERT_ACCESS_TOKEN;
const ctidAccountId = process.env.CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID;
const maxCanaryExposure = process.env.CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE;
const platformClientId = process.env.CTRADER_CLIENT_ID;
const platformClientSecret = process.env.CTRADER_CLIENT_SECRET;
const instrument = process.env.CTRADER_LIVE_CERT_INSTRUMENT;
const evidenceDir = process.env.IREXPRO_LIVE_CERT_EVIDENCE_DIR;
const requestedBrokerId = process.env.CTRADER_LIVE_CERT_BROKER_ID ?? 'ctrader';

const configured =
  gate.allowLiveCertification &&
  Boolean(
    operatorId &&
    accessToken &&
    ctidAccountId &&
    maxCanaryExposure &&
    platformClientId &&
    platformClientSecret,
  );

const describeCtraderLiveCertification = configured ? describe : describe.skip;

describeCtraderLiveCertification(
  'cTrader LIVE certification harness (operator-run, env-gated, REAL money)',
  () => {
    it('certifies the real live.ctraderapi.com account end-to-end and writes the evidence artifact', async () => {
      const evidence = await runLiveProviderCertification({
        gate,
        target: {
          brokerId: requestedBrokerId,
          accountId: ctidAccountId!,
          credentialSource:
            'env:CTRADER_LIVE_CERT_ACCESS_TOKEN (operator-supplied cTrader OAuth access token)',
        },
        operator: { operatorId: operatorId!, evidenceDir },
        maxCanaryExposure: maxCanaryExposure!,
        credentials: { apiKey: accessToken!, accountId: ctidAccountId! },
        ...(instrument ? { instrument } : {}),
      });

      // Sanitized evidence — safe to print by construction (no credentials).
      console.log(
        `cTrader (${requestedBrokerId}) LIVE certification evidence:\n`,
        JSON.stringify(evidence, null, 2),
      );
      console.log('Evidence artifact:', evidence.artifactPath ?? '(artifact write failed)');

      expect(evidence.mode).toBe('LIVE');
      expect(evidence.brokerId).toBe(requestedBrokerId);
      expect(evidence.overall).toBe('PASS');
      // A certification PASS means zero failures AND the complete canary
      // lifecycle (place → close → verify-closed → zero unexpected exposure).
      expect(evidence.summary.failed).toBe(0);
      expect(evidence.summary.passed).toBeGreaterThan(0);
    }, 300_000);

    it('never includes the access token in the sanitized evidence', async () => {
      const evidence = await runLiveProviderCertification({
        gate,
        target: {
          brokerId: requestedBrokerId,
          accountId: ctidAccountId!,
          credentialSource:
            'env:CTRADER_LIVE_CERT_ACCESS_TOKEN (operator-supplied cTrader OAuth access token)',
        },
        operator: { operatorId: operatorId!, evidenceDir },
        maxCanaryExposure: maxCanaryExposure!,
        credentials: { apiKey: accessToken!, accountId: ctidAccountId! },
        ...(instrument ? { instrument } : {}),
      });
      expect(JSON.stringify(evidence)).not.toContain(accessToken!);
    }, 300_000);
  },
);

// Always-on gate-closed proof (the CI state): with the env gate absent the
// typed refusal fires BEFORE any provider call / adapter construction — the
// operator-run branch above stays describe.skip'd in exactly that state.
const describeCtraderGateClosed = gate.allowLiveCertification ? describe.skip : describe;

describeCtraderGateClosed('cTrader LIVE certification harness (gate-closed)', () => {
  it('refuses with a typed error and zero provider calls when the env gate is not armed', async () => {
    await expect(
      runLiveProviderCertification({
        gate,
        target: {
          brokerId: requestedBrokerId,
          accountId: ctidAccountId ?? 'gate-closed-row',
          credentialSource: 'env-gated spec (gate-closed row — no provider contact)',
        },
        operator: { operatorId: operatorId ?? 'gate-closed-row' },
        maxCanaryExposure: maxCanaryExposure ?? '1',
        credentials: { accountId: ctidAccountId ?? 'gate-closed-row' },
      }),
    ).rejects.toThrow(LiveCertificationGateDisabledError);
  });
});
