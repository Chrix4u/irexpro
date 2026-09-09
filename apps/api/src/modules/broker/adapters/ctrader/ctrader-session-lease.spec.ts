/**
 * cTrader session lease lifecycle — adversarial coverage (Sprint 56
 * correction round 3; Task 2-a).
 *
 * Architect finding 4 (session leases / refcounting): the 2102 account
 * session on a shared environment connection is PROVIDER infrastructure —
 * every adapter context (one per persisted BrokerConnection.id, plus
 * ephemeral credential-test contexts) holds a NAMED lease. Disconnecting one
 * context must NEVER remove a session another context still requires; the
 * session (and the environment transport) is torn down only when the LAST
 * owner releases.
 *
 * Architect finding 5 (credential-test disposal): ephemeral testConnection
 * contexts dispose their leases in a finally path — partial failures after a
 * successful 2102 can never leak a session, and a PERSISTED connection
 * sharing the same account is never invalidated by a credential test.
 *
 * Architect finding 6 (identity enforcement on connect): a broker-specific
 * alias ('pepperstone-ctrader') rejects an account discovered under a
 * different brand ('IC Markets') with AUTHENTICATION_FAILED; the generic
 * 'ctrader' id accepts it.
 *
 * Client-level tests drive CTraderClientService directly through the fake
 * transport; adapter-level tests use TWO CTraderAdapter contexts sharing ONE
 * client (the connection-scoped factory reality).
 */
import { ConfigService } from '@nestjs/config';
import { CTraderAdapter } from './ctrader.adapter';
import { CTraderClientService } from './ctrader-client.service';
import { CtraderTransport } from './ctrader-transport';
import { FakeCtraderTransport, ScriptedCtraderServer } from './ctrader.fake-transport';
import { CTRADER_PAYLOAD_TYPE } from './ctrader-message-types';
import { BrokerErrorCode } from '../../interfaces/broker-adapter.errors';

const ACCOUNT_ID = '1234567';
const LIVE_ACCOUNT_ID = '7654321';
const ACCESS_TOKEN = 'test-access-token';

function fakeConfigService(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue ?? '',
  } as unknown as ConfigService;
}

/** Testable client: shadows the transport factory with the fake transport. */
class TestableCtraderClient extends CTraderClientService {
  readonly createdTransports: FakeCtraderTransport[] = [];

  constructor(server: ScriptedCtraderServer) {
    super(
      fakeConfigService({
        'broker.ctraderClientId': 'test-client-id',
        'broker.ctraderClientSecret': 'test-client-secret',
      }),
    );
    this.server = server;
  }

  private readonly server: ScriptedCtraderServer;

  protected createTransport(): CtraderTransport {
    const transport = new FakeCtraderTransport(this.server);
    this.createdTransports.push(transport);
    return transport;
  }
}

describe('cTrader session lease lifecycle (findings 4 + 5 + 6)', () => {
  let server: ScriptedCtraderServer;
  let client: TestableCtraderClient;

  beforeEach(() => {
    server = new ScriptedCtraderServer();
    client = new TestableCtraderClient(server);
  });

  afterEach(async () => {
    await client.onModuleDestroy();
  });

  /** Number of 2102 ACCOUNT_AUTH_REQ frames the scripted server received. */
  function countAccountAuths(): number {
    return server.requests.filter((r) => r.payloadType === CTRADER_PAYLOAD_TYPE.ACCOUNT_AUTH_REQ)
      .length;
  }

  // ─── Client-level: lease refcounting (finding 4) ───────────────────────────

  describe('client-level lease refcounting', () => {
    it('two owners on the SAME account share ONE session and ONE 2102 authorization', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-A');
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-B');

      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(2);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
      expect(client.isEnvConnected('DEMO')).toBe(true);
      // ONE transport, ONE account auth — the second owner reuses the session.
      expect(client.createdTransports).toHaveLength(1);
      expect(countAccountAuths()).toBe(1);
    });

    it('removing ONE owner keeps the session alive for the remaining owner (finding 4)', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-A');
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-B');

      await client.removeAccountSession('DEMO', ACCOUNT_ID, 'owner-A');

      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(1);
      // The session SURVIVES — the remaining owner still requires it.
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
      expect(client.isEnvConnected('DEMO')).toBe(true);
      expect(client.createdTransports[0].isOpen()).toBe(true);
    });

    it('removing the LAST owner tears the session AND the environment connection down', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-A');
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-B');
      await client.removeAccountSession('DEMO', ACCOUNT_ID, 'owner-A');

      await client.removeAccountSession('DEMO', ACCOUNT_ID, 'owner-B');

      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(0);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(false);
      expect(client.isEnvConnected('DEMO')).toBe(false);
      expect(client.createdTransports[0].isOpen()).toBe(false);
    });

    it('releaseOwnerSessions releases across BOTH environments (DEMO + LIVE)', async () => {
      const owner = 'multi-env-owner';
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, owner);
      await client.ensureAccountSession('LIVE', LIVE_ACCOUNT_ID, ACCESS_TOKEN, owner);

      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(1);
      expect(client.accountSessionOwnerCount('LIVE', LIVE_ACCOUNT_ID)).toBe(1);
      expect(client.isEnvConnected('DEMO')).toBe(true);
      expect(client.isEnvConnected('LIVE')).toBe(true);
      expect(client.createdTransports).toHaveLength(2);

      await client.releaseOwnerSessions(owner);

      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(0);
      expect(client.accountSessionOwnerCount('LIVE', LIVE_ACCOUNT_ID)).toBe(0);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(false);
      expect(client.hasAccountSession('LIVE', LIVE_ACCOUNT_ID)).toBe(false);
      expect(client.isEnvConnected('DEMO')).toBe(false);
      expect(client.isEnvConnected('LIVE')).toBe(false);
      expect(client.createdTransports[0].isOpen()).toBe(false);
      expect(client.createdTransports[1].isOpen()).toBe(false);
    });

    it('releasing an owner that never held a lease is a no-op (other owners unaffected)', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-A');
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-B');

      await client.releaseOwnerSessions('never-held-a-lease');

      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(2);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
      expect(client.isEnvConnected('DEMO')).toBe(true);
    });

    it('an unknown-owner removal does not tear down other owners’ session', async () => {
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-A');
      await client.ensureAccountSession('DEMO', ACCOUNT_ID, ACCESS_TOKEN, 'owner-B');

      await client.removeAccountSession('DEMO', ACCOUNT_ID, 'ghost-owner');

      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(2);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
      expect(client.isEnvConnected('DEMO')).toBe(true);
    });
  });

  // ─── Adapter-level: two adapters sharing ONE client (finding 4) ────────────

  describe('adapter-level leases — two CTraderAdapter contexts, one client', () => {
    it('both adapters connect through ONE shared session (one 2102) with two leases', async () => {
      const adapterA = new CTraderAdapter(client);
      const adapterB = new CTraderAdapter(client);

      await adapterA.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
      await adapterB.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });

      expect(adapterA.isConnected()).toBe(true);
      expect(adapterB.isConnected()).toBe(true);
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(2);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
      // The shared provider session was authorized exactly ONCE.
      expect(countAccountAuths()).toBe(1);
      expect(client.createdTransports).toHaveLength(1);
    });

    it('disconnecting adapterA NEVER removes the session adapterB requires (finding 4)', async () => {
      const adapterA = new CTraderAdapter(client);
      const adapterB = new CTraderAdapter(client);
      await adapterA.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
      await adapterB.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });

      await adapterA.disconnect();

      expect(adapterA.isConnected()).toBe(false);
      // B keeps the session, the transport and its connectivity.
      expect(adapterB.isConnected()).toBe(true);
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(1);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
      expect(client.isEnvConnected('DEMO')).toBe(true);
    });

    it('the LAST adapter disconnect tears the session and the environment down', async () => {
      const adapterA = new CTraderAdapter(client);
      const adapterB = new CTraderAdapter(client);
      await adapterA.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
      await adapterB.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
      await adapterA.disconnect();

      await adapterB.disconnect();

      expect(adapterB.isConnected()).toBe(false);
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(0);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(false);
      expect(client.isEnvConnected('DEMO')).toBe(false);
    });
  });

  // ─── Credential-test disposal (finding 5) ──────────────────────────────────

  describe('credential-test disposal (testConnection finally path)', () => {
    it('an ephemeral testConnection disposes its own session even when it is the ONLY owner', async () => {
      const ephemeral = new CTraderAdapter(client);

      const result = await ephemeral.testConnection({
        apiKey: ACCESS_TOKEN,
        accountId: ACCOUNT_ID,
      });

      expect(result.success).toBe(true);
      expect(result.accountId).toBe(ACCOUNT_ID);
      // The ephemeral context leaked NOTHING — success disposes too.
      expect(ephemeral.isConnected()).toBe(false);
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(0);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(false);
      expect(client.isEnvConnected('DEMO')).toBe(false);
    });

    it('an ephemeral testConnection NEVER invalidates a persisted connection’s session (finding 5)', async () => {
      const persisted = new CTraderAdapter(client);
      await persisted.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(1);

      const ephemeral = new CTraderAdapter(client);
      const result = await ephemeral.testConnection({
        apiKey: ACCESS_TOKEN,
        accountId: ACCOUNT_ID,
      });

      expect(result.success).toBe(true);
      // The ephemeral lease was released — back to the persisted owner only.
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(1);
      // The persisted connection was NOT invalidated by the credential test.
      expect(persisted.isConnected()).toBe(true);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
      expect(client.isEnvConnected('DEMO')).toBe(true);
    });

    it('a PARTIAL FAILURE after a successful 2102 still disposes the ephemeral lease (discovery fails)', async () => {
      const persisted = new CTraderAdapter(client);
      await persisted.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });

      // From here on, account discovery (2149) fails — the ephemeral context
      // will have a live 2102 lease BEFORE the failure point.
      server.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (_payload, envelope) => ({
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
        payload: { errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'token revoked' },
      }));

      const ephemeral = new CTraderAdapter(client);
      const result = await ephemeral.testConnection({
        apiKey: ACCESS_TOKEN,
        accountId: ACCOUNT_ID,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(BrokerErrorCode.AUTHENTICATION_FAILED);
      // The finally path covered the partial failure — no leaked lease.
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(1);
      // The persisted connection survived the ephemeral failure untouched.
      expect(persisted.isConnected()).toBe(true);
      expect(client.hasAccountSession('DEMO', ACCOUNT_ID)).toBe(true);
    });

    it('a PARTIAL FAILURE after a successful 2102 still disposes the ephemeral lease (trader fetch fails)', async () => {
      const persisted = new CTraderAdapter(client);
      await persisted.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });

      // The trader fetch (2121) fails AFTER the session + discovery succeeded.
      server.on(CTRADER_PAYLOAD_TYPE.TRADER_REQ, (_payload, envelope) => ({
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.OA_ERROR_RES,
        payload: { errorCode: 'SERVER_IS_UNDER_MAINTENANCE', description: 'brief outage' },
      }));

      const ephemeral = new CTraderAdapter(client);
      const result = await ephemeral.testConnection({
        apiKey: ACCESS_TOKEN,
        accountId: ACCOUNT_ID,
      });

      expect(result.success).toBe(false);
      expect(ephemeral.isConnected()).toBe(false);
      // Lease released back to the persisted owner — no leak on the finally path.
      expect(client.accountSessionOwnerCount('DEMO', ACCOUNT_ID)).toBe(1);
      expect(persisted.isConnected()).toBe(true);
    });
  });

  // ─── Connect-time broker identity enforcement (finding 6) ──────────────────

  describe('connect-time broker identity enforcement (finding 6)', () => {
    /** Scripts discovery to answer a single account with the given brand. */
    function scriptDiscoveryBrand(brokerTitleShort: string): void {
      server.on(CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, (payload, envelope) => ({
        clientMsgId: envelope.clientMsgId,
        payloadType: CTRADER_PAYLOAD_TYPE.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
        payload: {
          accessToken: payload.accessToken,
          permissionScope: 1,
          ctidTraderAccount: [
            {
              ctidTraderAccountId: Number(ACCOUNT_ID),
              isLive: false,
              traderLogin: Number(ACCOUNT_ID),
              brokerTitleShort,
            },
          ],
        },
      }));
    }

    it('rejects an IC-Markets-discovered account under the pepperstone-ctrader alias', async () => {
      scriptDiscoveryBrand('IC Markets');
      const aliasAdapter = new CTraderAdapter(client, 'pepperstone-ctrader');

      let caught: unknown;
      try {
        await aliasAdapter.connect({ apiKey: ACCESS_TOKEN, accountId: ACCOUNT_ID });
        fail('expected the alias adapter connect to reject');
      } catch (err) {
        caught = err;
      }

      // The credentials are VALID for cTrader but the account belongs to a
      // DIFFERENT brand — an identity-level authentication failure naming
      // BOTH the discovered title and the requested alias id.
      expect(caught).toMatchObject({ code: BrokerErrorCode.AUTHENTICATION_FAILED });
      const message = (caught as Error).message;
      expect(message).toContain('IC Markets');
      expect(message).toContain('pepperstone-ctrader');
    });

    it('the generic ctrader adapter accepts the SAME discovery (broker-agnostic)', async () => {
      scriptDiscoveryBrand('IC Markets');
      const genericAdapter = new CTraderAdapter(client);

      const result = await genericAdapter.connect({
        apiKey: ACCESS_TOKEN,
        accountId: ACCOUNT_ID,
      });

      expect(result.success).toBe(true);
      expect(genericAdapter.isConnected()).toBe(true);
    });

    it('a matching brand connects under the broker-specific alias', async () => {
      scriptDiscoveryBrand('Pepperstone (UK)');
      const aliasAdapter = new CTraderAdapter(client, 'pepperstone-ctrader');

      const result = await aliasAdapter.connect({
        apiKey: ACCESS_TOKEN,
        accountId: ACCOUNT_ID,
      });

      expect(result.success).toBe(true);
      expect(aliasAdapter.isConnected()).toBe(true);
    });
  });
});
