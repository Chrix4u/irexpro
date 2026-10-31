import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { existsSync } from 'fs';
import { DirectMt5Adapter } from '../adapters/direct-mt5/direct-mt5.adapter';
import { DirectMt5CommandService } from '../direct-mt5/direct-mt5-command.service';
import {
  LiveCertificationGateDisabledError,
  isCertifiablePass,
  resolveLiveCertificationGateFromEnv,
  runLiveProviderCertification,
} from './provider-live-certification-harness';

/** Operator-only REAL-MONEY certification for the native Direct MT5 route.
 * CI never sets the gate/connection/account/cap variables, therefore the
 * provider branch is structurally skipped and the always-on gate-closed proof
 * below makes accidental real-money execution impossible.
 */
const gate = resolveLiveCertificationGateFromEnv();
const operatorId = process.env.IREXPRO_LIVE_CERT_OPERATOR_ID;
const connectionId = process.env.DIRECT_MT5_LIVE_CERT_CONNECTION_ID;
const accountLogin = process.env.DIRECT_MT5_LIVE_CERT_ACCOUNT_LOGIN;
const maxCanaryExposure = process.env.DIRECT_MT5_LIVE_CERT_MAX_CANARY_EXPOSURE;
const instrument = process.env.DIRECT_MT5_LIVE_CERT_INSTRUMENT;
const evidenceDir = process.env.IREXPRO_LIVE_CERT_EVIDENCE_DIR;
const configured = gate.allowLiveCertification && Boolean(operatorId && connectionId && accountLogin && maxCanaryExposure);
const describeDirectMt5Live = configured ? describe : describe.skip;

describeDirectMt5Live('Direct MT5 LIVE certification (operator-run, env-gated, REAL money)', () => {
  let moduleRef: TestingModule;
  beforeAll(async () => {
    // Dynamic import is deliberate: gate-closed CI/test discovery must not load
    // AppModule, validate production env, initialize DB config or touch providers.
    const { AppModule } = await import('../../../app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  });
  afterAll(async () => {
    await moduleRef?.close();
  });

  it('runs the native paired terminal through the complete LIVE canary and persists evidence', async () => {
    const commands = moduleRef.get(DirectMt5CommandService);
    const adapter = new DirectMt5Adapter(commands, connectionId!);
    const evidence = await runLiveProviderCertification({
      gate,
      target: {
        brokerId: 'direct-mt5',
        accountId: accountLogin!,
        credentialSource: 'paired Direct MT5 protocol-v2 terminal connector (no broker password stored by iRexPro)',
      },
      operator: { operatorId: operatorId!, evidenceDir },
      maxCanaryExposure: maxCanaryExposure!,
      credentials: { accountId: accountLogin! },
      adapter,
      ...(instrument ? { instrument } : {}),
    });
    expect(evidence.mode).toBe('LIVE');
    expect(evidence.brokerId).toBe('direct-mt5');
    expect(evidence.certificationResult).toBe('PASS');
    expect(evidence.evidenceState).toBe('PERSISTED');
    expect(isCertifiablePass(evidence)).toBe(true);
    expect(evidence.artifactPath).toBeDefined();
    expect(existsSync(evidence.artifactPath!)).toBe(true);
    expect(evidence.summary.failed).toBe(0);
  }, 300_000);
});

const describeGateClosed = gate.allowLiveCertification ? describe.skip : describe;
describeGateClosed('Direct MT5 LIVE certification (gate-closed)', () => {
  it('refuses before adapter construction/provider contact when the master gate is disabled', async () => {
    await expect(runLiveProviderCertification({
      gate,
      target: { brokerId: 'direct-mt5', accountId: 'gate-closed-row', credentialSource: 'gate-closed test row' },
      operator: { operatorId: 'gate-closed-row' },
      maxCanaryExposure: '1',
      credentials: { accountId: 'gate-closed-row' },
    })).rejects.toThrow(LiveCertificationGateDisabledError);
  });
});
