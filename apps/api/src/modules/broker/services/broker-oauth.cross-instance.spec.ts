import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { BrokerOAuthService } from './broker-oauth.service';
import { BrokerService } from '../broker.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { CtraderDiscoveredAccount } from '../adapters/ctrader/ctrader-message-types';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerMode } from '../interfaces/broker-adapter.interface';
import { BrokerOAuthFlow } from '../entities/broker-oauth-flow.entity';
import { BrokerLinkOutbox } from '../entities/broker-link-outbox.entity';
import { CredentialEncryptionService } from './credential-encryption.service';
import { BrokerLinkOutboxService } from './broker-link-outbox.service';
import { DomainEventBus } from '../../events/event-bus.service';

/**
 * Sprint 56 correction round 2 (architect finding 2) — the OAuth flow store
 * is REPLICA-SAFE: every assertion below runs against ONE shared in-memory
 * sqlite store (standing in for the shared PostgreSQL database) driven by
 * TWO (and later THREE) independent BrokerOAuthService instances — the exact
 * multi-replica / restart-survival guarantees the process-local Map could
 * never provide:
 *
 * - authorize on instance A → complete on B → link on A (the full
 *   architect-required sequence across instances);
 * - concurrent duplicate completion → exactly ONE winner (CAS), the other
 *   fails closed (authorization-code replay protection);
 * - concurrent duplicate link → exactly ONE winner (LINKING CAS);
 * - a THIRD instance created after "forgetting" the first two continues the
 *   flow (process restart does not invalidate a valid in-flight flow);
 * - cross-user completion/linking behaves exactly like unknown flows;
 * - expiry, handoff replay/expiry/cross-user, mobile slot lifecycle, and the
 *   ambiguous-callback hard fail-closed all hold across instances.
 */

const USER = '11111111-1111-1111-1111-111111111111';
const FOREIGN_USER = '22222222-2222-2222-2222-222222222222';
const WEB_REDIRECT = 'https://app.irexpro.com/onboarding/broker/callback';
const MOBILE_SLOT_1 = 'https://api.irexpro.com/api/v1/broker/connections/oauth/callback/m1';
const MOBILE_SLOT_2 = 'https://api.irexpro.com/api/v1/broker/connections/oauth/callback/m2';
const SLOT_1_PATH = '/api/v1/broker/connections/oauth/callback/m1';
const ENCRYPTION_KEY = 'cross-instance-broker-encryption-key!!';
const AUTHORIZATION_CODE = 'the-single-use-code';
const ACCESS_TOKEN = 'SEKRIT-ACCESS-TOKEN';
const REFRESH_TOKEN = 'SEKRIT-REFRESH-TOKEN';

const discoveredAccounts = (): CtraderDiscoveredAccount[] => [
  {
    ctidTraderAccountId: 1234567,
    isLive: false,
    traderLogin: 987654,
    brokerTitleShort: 'Spotware',
  },
  {
    ctidTraderAccountId: 7654321,
    isLive: true,
    traderLogin: 123456,
    brokerTitleShort: 'Pepperstone',
  },
];

describe('BrokerOAuthService cross-instance flow store (architect finding 2)', () => {
  let dataSource: DataSource;
  let flowRepo: Repository<BrokerOAuthFlow>;
  let encryption: CredentialEncryptionService;
  let brokerService: { createConnection: jest.Mock; findLiveConnectionByLogicalKey: jest.Mock };
  let linkOutbox: BrokerLinkOutboxService;
  let ctraderClient: {
    isAvailable: jest.Mock;
    buildAuthorizationUrl: jest.Mock;
    exchangeAuthorizationCode: jest.Mock;
    discoverAccounts: jest.Mock;
  };
  let audit: { log: jest.Mock };

  /** One simulated API replica sharing the store + collaborator mocks. */
  const makeInstance = (): BrokerOAuthService =>
    new BrokerOAuthService(
      brokerService as unknown as BrokerService,
      ctraderClient as unknown as CTraderClientService,
      audit as unknown as AuditService,
      new ConfigService({
        broker: {
          ctraderRedirectUris: WEB_REDIRECT,
          ctraderMobileCallbackUris: `${MOBILE_SLOT_1},${MOBILE_SLOT_2}`,
        },
      }) as unknown as ConfigService,
      encryption,
      flowRepo,
      // Sprint 56 correction round 5 (#332): the REAL durable outbox over the
      // shared store — every replica shares it exactly like the flow store.
      linkOutbox,
    );

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: true,
      entities: [BrokerOAuthFlow, BrokerLinkOutbox],
    });
    await dataSource.initialize();
    flowRepo = dataSource.getRepository(BrokerOAuthFlow);

    encryption = new CredentialEncryptionService(
      new ConfigService({ BROKER_ENCRYPTION_KEY: ENCRYPTION_KEY }) as unknown as ConfigService,
    );

    brokerService = {
      createConnection: jest.fn(),
      // Sprint 56 correction round 5 (#332): the durable-idempotency
      // adoption pre-check — no existing live connection by default (the
      // mocked createConnection owns the row creation in this suite).
      findLiveConnectionByLogicalKey: jest.fn().mockResolvedValue(null),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    // The REAL outbox service over the shared store (adoption audits land
    // here; the sweep is exercised by the dedicated outbox spec).
    linkOutbox = new BrokerLinkOutboxService(
      dataSource.getRepository(BrokerLinkOutbox),
      audit as unknown as AuditService,
      new DomainEventBus(),
    );
    ctraderClient = {
      isAvailable: jest.fn().mockReturnValue(true),
      buildAuthorizationUrl: jest
        .fn()
        .mockReturnValue('https://id.ctrader.com/consent?client_id=pub-client-id&scope=trading'),
      exchangeAuthorizationCode: jest.fn().mockResolvedValue({
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresIn: 2_628_000,
      }),
      discoverAccounts: jest.fn().mockResolvedValue(discoveredAccounts()),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    ctraderClient.isAvailable.mockReturnValue(true);
    ctraderClient.exchangeAuthorizationCode.mockResolvedValue({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresIn: 2_628_000,
    });
    ctraderClient.discoverAccounts.mockResolvedValue(discoveredAccounts());
    brokerService.createConnection.mockReset();
    brokerService.createConnection.mockResolvedValue({
      id: 'new-conn-1',
      brokerId: 'ctrader',
      accountType: BrokerMode.DEMO,
    } as unknown as BrokerConnection);
    brokerService.findLiveConnectionByLogicalKey.mockResolvedValue(null);
    await flowRepo.clear();
    await dataSource.getRepository(BrokerLinkOutbox).clear();
  });

  const authorizeOn = (instance: BrokerOAuthService, channel: 'web' | 'mobile' = 'web') =>
    instance.startAuthorization(USER, 'ctrader', undefined, undefined, channel);

  // ─── The architect-required cross-replica sequence ─────────────────────────

  it('authorize on A → complete on B → link on A: the flow survives replica boundaries', async () => {
    const a = makeInstance();
    const b = makeInstance();

    const start = await authorizeOn(a);
    // Complete on ANOTHER replica (load-balanced request).
    const completed = await b.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);
    expect(completed.accounts).toHaveLength(2);
    // Link back on the FIRST replica.
    const connection = await a.linkAccount(USER, start.flowId, '1234567');
    expect(brokerService.createConnection).toHaveBeenCalledTimes(1);
    const dto = brokerService.createConnection.mock.calls[0][0];
    expect(dto.apiKey).toBe(ACCESS_TOKEN);
    expect(dto.additionalParams).toMatchObject({ refreshToken: REFRESH_TOKEN });
    expect(connection.id).toBe('new-conn-1');

    // Single-use everywhere: the flow is CONSUMED with zeroed token columns.
    const stored = await flowRepo.findOne({ where: { id: start.flowId } });
    expect(stored!.state).toBe('CONSUMED');
    expect(stored!.tokenCiphertext).toBeNull();
  });

  it('concurrent duplicate completion on two replicas → exactly ONE winner (replay fails closed)', async () => {
    const a = makeInstance();
    const b = makeInstance();
    const start = await authorizeOn(a);

    const results = await Promise.allSettled([
      a.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE),
      b.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    // Exactly ONE row state transition and ONE completion audit event.
    const stored = await flowRepo.findOne({ where: { id: start.flowId } });
    expect(stored!.state).toBe('AUTHORIZED');
    expect(stored!.tokenCiphertext).toBeTruthy();
    const completions = audit.log.mock.calls.filter(
      (c) => c[0].action === AuditAction.BROKER_OAUTH_AUTHORIZATION_COMPLETED,
    );
    expect(completions).toHaveLength(1);
  });

  it('concurrent duplicate link on two replicas → exactly ONE consumer (LINKING CAS)', async () => {
    const a = makeInstance();
    const b = makeInstance();
    const start = await authorizeOn(a);
    await a.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);

    const results = await Promise.allSettled([
      a.linkAccount(USER, start.flowId, '1234567'),
      b.linkAccount(USER, start.flowId, '1234567'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(((rejected[0] as PromiseRejectedResult).reason as ConflictException).message).toContain(
      'Account linking is already in progress',
    );
    // The connection was created exactly once.
    expect(brokerService.createConnection).toHaveBeenCalledTimes(1);
    const stored = await flowRepo.findOne({ where: { id: start.flowId } });
    expect(stored!.state).toBe('CONSUMED');
  });

  // ─── Sprint 56 correction round 4 (architect finding 2): LINKING is
  // exactly-once — the stale-LINKING reclaim window is REMOVED. A paused
  // linker can never be overtaken by a second claimant, no matter how long
  // it pauses. ────────────────────────────────────────────────────────────

  it("PAUSED linker is never overtaken: B cannot reclaim A's LINKING claim even far past the former stale threshold (exactly-once, finding 2)", async () => {
    const a = makeInstance();
    const b = makeInstance();
    const start = await authorizeOn(a);
    await a.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);

    // Pause instance A INSIDE createConnection (mid-side-effect).
    const resume: { fn?: (value: unknown) => void } = {};
    brokerService.createConnection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume.fn = resolve;
        }),
    );
    const promiseA = a.linkAccount(USER, start.flowId, '1234567');
    // Let A reach the paused createConnection (LINKING claim already made).
    await new Promise((r) => setTimeout(r, 25));

    // Advance FAR beyond the former 60 s stale threshold — time alone must
    // NOT make the claim re-claimable.
    await flowRepo.update(start.flowId, {
      stateChangedAt: new Date(Date.now() - 300_000),
    });

    // Instance B attempts to link (same account AND a different account).
    await expect(b.linkAccount(USER, start.flowId, '1234567')).rejects.toThrow(
      'Account linking is already in progress',
    );
    await expect(b.linkAccount(USER, start.flowId, '7654321')).rejects.toThrow(
      'Account linking is already in progress',
    );
    // B never reached a side effect.
    expect(brokerService.createConnection).toHaveBeenCalledTimes(1); // only A's in-flight call

    // Resume A — the ONLY linker completes.
    resume.fn?.({
      id: 'new-conn-1',
      brokerId: 'ctrader',
      accountType: BrokerMode.DEMO,
    } as unknown as BrokerConnection);
    const connection = await promiseA;
    expect(connection.id).toBe('new-conn-1');

    // EXACTLY ONE connection-creation side effect in total.
    expect(brokerService.createConnection).toHaveBeenCalledTimes(1);
    // The DTO carried A's ORIGINAL account selection — no account mutation.
    const dto = brokerService.createConnection.mock.calls[0][0];
    expect(dto.accountId).toBe('1234567');
    // EXACTLY ONE flow consumer: CONSUMED with token columns zeroed once.
    const stored = await flowRepo.findOne({ where: { id: start.flowId } });
    expect(stored!.state).toBe('CONSUMED');
    expect(stored!.tokenCiphertext).toBeNull();
    expect(stored!.tokenIv).toBeNull();
    expect(stored!.tokenTag).toBeNull();
    // Sprint 56 correction round 5 (#332): EXACTLY ONE linked-audit is handed
    // to the durable outbox channel (the round ≤4 spec asserted one
    // synchronous audit.log call — the audit now commits atomically with the
    // connection inside the (here mocked) createConnection and is delivered
    // by the outbox sweep).
    const serverDerivedArgs = brokerService.createConnection.mock.calls
      .map((call: unknown[]) => call[3] as { linkAudit?: { payload: { action: string } } })
      .filter((arg) => arg?.linkAudit);
    expect(serverDerivedArgs).toHaveLength(1);
    expect(serverDerivedArgs[0]!.linkAudit!.payload.action).toBe(
      AuditAction.BROKER_OAUTH_ACCOUNT_LINKED,
    );
    // No duplicate credential submission (exactly one createConnection call
    // means exactly one encrypted-credential write through the broker service).
  });

  it('a crashed LINKING flow is recovered by EXPIRY, never by reclaim (finding 2)', async () => {
    const a = makeInstance();
    const start = await authorizeOn(a);
    await a.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);

    // A crashed linker left the flow in LINKING; the authorization TTL lapses.
    await flowRepo.update(start.flowId, {
      state: 'LINKING',
      expiresAt: new Date(Date.now() - 1_000),
    });

    // Any later link attempt fails closed with the expiry message and the
    // expired row is deleted (bounded store).
    await expect(a.linkAccount(USER, start.flowId, '1234567')).rejects.toThrow(
      'The broker OAuth authorization has expired',
    );
    expect(await flowRepo.findOne({ where: { id: start.flowId } })).toBeNull();
    expect(brokerService.createConnection).not.toHaveBeenCalled();
  });

  it('a THIRD instance (process restart) continues an otherwise-valid flow', async () => {
    // Instance A starts the flow, then is "restarted away" — the state lives
    // in the shared store, not in any process.
    const a = makeInstance();
    const start = await authorizeOn(a);

    const c = makeInstance();
    const completed = await c.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);
    expect(completed.accounts).toHaveLength(2);
    const connection = await c.linkAccount(USER, start.flowId, '1234567');
    expect(connection.id).toBe('new-conn-1');
  });

  // ─── Cross-user isolation ───────────────────────────────────────────────────

  it('cross-user completion/linking behaves EXACTLY like an unknown flow (no oracle)', async () => {
    const a = makeInstance();
    const start = await authorizeOn(a);

    await expect(
      a.completeAuthorization(FOREIGN_USER, start.flowId, AUTHORIZATION_CODE),
    ).rejects.toThrow(NotFoundException);
    await expect(
      a.completeAuthorization(USER, '00000000-0000-0000-0000-000000000000', AUTHORIZATION_CODE),
    ).rejects.toThrow(NotFoundException);

    // Complete as the owner, then prove the same rule on link — with the
    // IDENTICAL message for foreign and unknown flows (no existence oracle).
    await a.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE);
    const foreignErr = await a
      .linkAccount(FOREIGN_USER, start.flowId, '1234567')
      .catch((e: unknown) => e);
    const unknownErr = await a
      .linkAccount(USER, '00000000-0000-0000-0000-000000000000', '1234567')
      .catch((e: unknown) => e);
    expect(foreignErr).toBeInstanceOf(NotFoundException);
    expect(unknownErr).toBeInstanceOf(NotFoundException);
    expect((foreignErr as Error).message).toBe((unknownErr as Error).message);
  });

  // ─── Expiry ─────────────────────────────────────────────────────────────────

  it('expired PENDING flow complete → Conflict and the row is swept', async () => {
    const a = makeInstance();
    const start = await authorizeOn(a);
    await flowRepo.update(start.flowId, { expiresAt: new Date(Date.now() - 1_000) });
    await expect(a.completeAuthorization(USER, start.flowId, AUTHORIZATION_CODE)).rejects.toThrow(
      ConflictException,
    );
    expect(await flowRepo.findOne({ where: { id: start.flowId } })).toBeNull();
  });

  // ─── Mobile handoff across instances ────────────────────────────────────────

  it('mobile flow: authorize on A → server callback on B → handoff exchange on A (replay/expiry/cross-user fail closed)', async () => {
    const a = makeInstance();
    const b = makeInstance();
    const start = await authorizeOn(a, 'mobile');
    expect(start.flowId).toBeDefined();

    // The provider redirect lands on replica B's callback route.
    const cb = await b.handleMobileCallback(SLOT_1_PATH, AUTHORIZATION_CODE);
    expect(cb.status).toBe('ok');
    if (cb.status !== 'ok') return;
    // High-entropy handoff token (≥ 43 base64url chars).
    expect(cb.handoffToken.length).toBeGreaterThanOrEqual(43);

    // The app presents the handoff token to replica A.
    const exchanged = await a.exchangeHandoffToken(USER, cb.handoffToken);
    expect(exchanged.flowId).toBe(start.flowId);
    expect(exchanged.accounts).toHaveLength(2);

    // Replay (on either replica) fails closed as not-found.
    await expect(a.exchangeHandoffToken(USER, cb.handoffToken)).rejects.toThrow(NotFoundException);
    await expect(b.exchangeHandoffToken(USER, cb.handoffToken)).rejects.toThrow(NotFoundException);
  });

  it('expired handoff exchange → NotFound; cross-user handoff → NotFound', async () => {
    const a = makeInstance();
    const b = makeInstance();
    await authorizeOn(a, 'mobile');
    const cb = await b.handleMobileCallback(SLOT_1_PATH, AUTHORIZATION_CODE);
    expect(cb.status).toBe('ok');
    if (cb.status !== 'ok') return;

    await flowRepo.update(cb.flowId, {
      handoffExpiresAt: new Date(Date.now() - 1_000),
    });
    await expect(a.exchangeHandoffToken(USER, cb.handoffToken)).rejects.toThrow(NotFoundException);

    // Cross-user: a fresh handoff token issued for USER, presented by FOREIGN_USER.
    // (SLOT_1 is free again — the first flow left PENDING on completion.)
    const start2 = await authorizeOn(a, 'mobile');
    const cb2 = await b.handleMobileCallback(SLOT_1_PATH, AUTHORIZATION_CODE);
    expect(cb2.status).toBe('ok');
    if (cb2.status !== 'ok') return;
    await expect(a.exchangeHandoffToken(FOREIGN_USER, cb2.handoffToken)).rejects.toThrow(
      NotFoundException,
    );
    // …and the rightful owner can still consume it (single-use, user-bound).
    await expect(a.exchangeHandoffToken(USER, cb2.handoffToken)).resolves.toMatchObject({
      flowId: start2.flowId,
    });
  });

  // ─── Mobile slot lifecycle ──────────────────────────────────────────────────

  it('two configured slots serve two PARALLEL mobile flows; a third fails busy', async () => {
    const a = makeInstance();
    const b = makeInstance();
    const first = await authorizeOn(a, 'mobile');
    const second = await authorizeOn(b, 'mobile');
    // Distinct slots claimed atomically.
    const rows = await flowRepo.find({ where: { state: 'PENDING' as never } });
    expect(rows.map((r) => r.redirectUri).sort()).toEqual([MOBILE_SLOT_1, MOBILE_SLOT_2].sort());
    expect(first.flowId).not.toBe(second.flowId);
    // Both slots held → fail closed (busy).
    await expect(authorizeOn(a, 'mobile')).rejects.toThrow(ConflictException);
  });

  it('callback with ZERO pending flows errors clean (unknown-or-expired)', async () => {
    const a = makeInstance();
    const result = await a.handleMobileCallback(SLOT_1_PATH, AUTHORIZATION_CODE);
    expect(result).toEqual({ status: 'error', reason: 'unknown-or-expired' });
    expect(ctraderClient.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('callback happy path issues the handoff token (server-side exchange only)', async () => {
    const a = makeInstance();
    const b = makeInstance();
    await authorizeOn(a, 'mobile');
    const result = await b.handleMobileCallback(SLOT_1_PATH, AUTHORIZATION_CODE);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.handoffToken.length).toBeGreaterThanOrEqual(43);
    // The exchange used the slot redirect URI and happened server-side.
    expect(ctraderClient.exchangeAuthorizationCode).toHaveBeenCalledWith(
      AUTHORIZATION_CODE,
      MOBILE_SLOT_1,
    );
    // The flow is AUTHORIZED and awaits the handoff exchange + link.
    const stored = await flowRepo.findOne({ where: { id: result.flowId } });
    expect(stored!.state).toBe('AUTHORIZED');
  });

  it('ambiguous callback (two PENDING flows on one slot) → hard fail-closed, NEITHER completed', async () => {
    const a = makeInstance();
    // Simulate a slot-claim race/corruption by inserting a second PENDING row
    // with the same redirect URI as a legitimately claimed slot.
    await authorizeOn(a, 'mobile');
    await flowRepo.save(
      flowRepo.create({
        userId: FOREIGN_USER,
        brokerId: 'ctrader',
        redirectUri: MOBILE_SLOT_1,
        state: 'PENDING',
        stateChangedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const result = await a.handleMobileCallback(SLOT_1_PATH, AUTHORIZATION_CODE);
    expect(result).toEqual({ status: 'error', reason: 'ambiguous' });
    // No provider exchange for EITHER flow — never guess.
    expect(ctraderClient.exchangeAuthorizationCode).not.toHaveBeenCalled();
    const pending = await flowRepo.find({ where: { state: 'PENDING' as never } });
    expect(pending).toHaveLength(2);
  });
});
