import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerOAuthAccount, BrokerOAuthFlow } from '../entities/broker-oauth-flow.entity';
import { BrokerService } from '../broker.service';
import { CTraderClientService } from '../adapters/ctrader/ctrader-client.service';
import { CtraderDiscoveredAccount } from '../adapters/ctrader/ctrader-message-types';
import { CtraderOAuthTokens } from '../adapters/ctrader/ctrader-oauth';
import { ConnectBrokerDto } from '../dto/connect-broker.dto';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { CTRADER_FAMILY_BROKER_IDS } from '../registry/broker-catalog';
import { BrokerMode } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';
import { brokerIdentityMatches } from '../adapters/ctrader/ctrader-broker-identity';
import { CredentialEncryptionService } from './credential-encryption.service';

/** Lifetime of a PENDING flow (authorization not yet completed). */
const FLOW_PENDING_TTL_MS = 10 * 60_000;
/** Lifetime of an AUTHORIZED flow (tokens held in the store until linked). */
const FLOW_AUTHORIZED_TTL_MS = 5 * 60_000;
/** Lifetime of the one-time mobile handoff token (finding 4). */
const HANDOFF_TOKEN_TTL_MS = 120_000;
/** Bounded flow store — at most this many concurrent (non-CONSUMED, live) rows. */
const MAX_CONCURRENT_FLOWS = 1000;
/** Lazy sweep horizon: rows whose expires_at is older than this are deleted. */
const FLOW_SWEEP_GRACE_MS = 60 * 60_000;
/** A LINKING claim older than this may be re-claimed (crash recovery). */
const LINKING_STALE_MS = 60_000;
/** Handoff token entropy (bytes; base64url ⇒ ≥ 43 chars). */
const HANDOFF_TOKEN_BYTES = 32;

/** Authorization channel — decides which callback boundary is used. */
export type BrokerOAuthChannel = 'web' | 'mobile';

// The sanitized account shape is owned by the shared flow entity (persisted
// column + API response contract).
export type { BrokerOAuthAccount } from '../entities/broker-oauth-flow.entity';

/** Response of POST /broker/connections/oauth/authorize. */
export interface BrokerOAuthStartResult {
  authorizationUrl: string;
  flowId: string;
  expiresAt: string;
}

/** Response of POST /broker/connections/oauth/complete. */
export interface BrokerOAuthCompleteResult {
  flowId: string;
  accounts: BrokerOAuthAccount[];
}

/** Response of POST /broker/connections/oauth/handoff. */
export interface BrokerOAuthHandoffResult {
  flowId: string;
  accounts: BrokerOAuthAccount[];
}

/**
 * Outcome of the UNAUTHENTICATED mobile callback route. The controller renders
 * a clean deep-link redirect from it — the payload NEVER carries token
 * material, the provider code, or any user data beyond the opaque handoff
 * token itself.
 */
export type BrokerOAuthMobileCallbackResult =
  | { status: 'ok'; handoffToken: string; flowId: string }
  | {
      status: 'error';
      reason: 'missing-code' | 'unknown-or-expired' | 'ambiguous' | 'state' | 'exchange-failed';
    };

/**
 * BrokerOAuthService — the user-facing cTrader OAuth connection flow
 * (Sprint 56 correction round 1 / audit point 6; round 2 / architect findings
 * 2 + 4).
 *
 * THE FLOW (end-to-end):
 *   1. POST /broker/connections/oauth/authorize { brokerId, channel }
 *      (authenticated) → the server creates a SINGLE-USE flow row in the
 *      SHARED store (broker.broker_oauth_flows — PostgreSQL, the same
 *      database as every other entity; this repo has no Redis cache) bound to
 *      the requesting user, the broker, and the redirect URI, and returns the
 *      official id.ctrader.com consent URL. The frontend redirects the user
 *      there in an EXTERNAL browser — iRexPro NEVER sees the cTrader password.
 *      - channel 'web' (default): the registered HTTPS web callback page.
 *      - channel 'mobile': the server atomically claims one of the
 *        operator-configured HTTPS mobile callback SLOT URIs
 *        (CTRADER_MOBILE_CALLBACK_URIS — each registered on the Spotware
 *        application). cTrader OAuth supports NO state parameter, so
 *        correlation is by redirect-URI slot: the callback resolves the flow
 *        by the arriving request path.
 *   2a. WEB: Spotware redirects to the registered web page, which POSTs
 *       /complete { flowId, code }.
 *   2b. MOBILE (finding 4): Spotware redirects to the SERVER callback route
 *       (broker-oauth-callback.controller.ts, unauthenticated). The server
 *       resolves the flow from the slot path (exactly one PENDING unexpired
 *       flow must exist), consumes/exchanges the provider code SERVER-SIDE
 *       (the code, tokens, and app secret NEVER reach the mobile app), then
 *       issues a short-lived (120 s), high-entropy, ONE-TIME handoff token
 *       and answers with a 302 redirect to the configured deep link
 *       (irexpro://broker/oauth/handoff?token=…) plus a minimal fallback
 *       HTML anchor.
 *   3. WEB: POST /broker/connections/oauth/complete { flowId, code } → the
 *      server validates ownership/single-use/TTL, exchanges the code with the
 *      PLATFORM application credentials, discovers every cTID account granted
 *      to the token (isLive flags decide DEMO vs LIVE), and returns the
 *      sanitized account list. Tokens are persisted AES-256-GCM-encrypted in
 *      the flow row (encrypted at rest — the store is durable).
 *      MOBILE: POST /broker/connections/oauth/handoff { handoffToken } → the
 *      digest-verified, user-bound, single-use handoff token is exchanged for
 *      { flowId, accounts } (replay and cross-user use fail closed as
 *      not-found).
 *   4. POST /broker/connections/oauth/link { flowId, ctidTraderAccountId }
 *      → the chosen account is linked through the CANONICAL
 *      BrokerService.createConnection path: credentials (access token +
 *      refresh token + expiry tracking) are AES-256-GCM encrypted, the
 *      account type derives from the account's isLive flag, and LIVE linking
 *      for unverified brokers fails closed exactly like the manual path. The
 *      flow is consumed (single-use, via the transient LINKING claim).
 *
 * SECURITY INVARIANTS (adversarially tested, incl. cross-instance):
 * - Flow correlation is SERVER-SIDE, SHARED (PostgreSQL), and SINGLE-USE: a
 *   flow completes/links/exchanges exactly once, belongs to exactly one user,
 *   and expires — across replicas, restarts, and load-balanced requests.
 * - State transitions are conditional single-row UPDATEs (compare-and-set
 *   with affected-rows checks): authorization-code replay and concurrent
 *   duplicate completion/linking fail closed with Conflict.
 * - Cross-user lookups behave EXACTLY like unknown flows (no existence
 *   oracle).
 * - Application credentials (CTRADER_CLIENT_ID/SECRET) are server-only —
 *   users never supply or receive them; the provider code is exchanged
 *   server-side only.
 * - Access/refresh tokens are stored ONLY as AES-256-GCM ciphertext in the
 *   flow row and NEVER appear in responses, audit metadata, logs, or
 *   exception text. The handoff token is stored ONLY as its SHA-256 digest.
 * - The flow store is BOUNDED (MAX_CONCURRENT_FLOWS + lazy sweeps delete
 *   rows whose expires_at is older than one hour).
 */
@Injectable()
export class BrokerOAuthService {
  private readonly logger = new Logger(BrokerOAuthService.name);

  constructor(
    private readonly brokerService: BrokerService,
    private readonly ctraderClient: CTraderClientService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly encryptionService: CredentialEncryptionService,
    @InjectRepository(BrokerOAuthFlow)
    private readonly flowRepo: Repository<BrokerOAuthFlow>,
  ) {}

  // ─── Step 1: authorization start ───────────────────────────────────────────

  async startAuthorization(
    userId: string,
    brokerId: string,
    ipAddress?: string,
    redirectUri?: string,
    channel: BrokerOAuthChannel = 'web',
  ): Promise<BrokerOAuthStartResult> {
    if (!CTRADER_FAMILY_BROKER_IDS.includes(brokerId)) {
      throw new BadRequestException(
        `Broker "${brokerId}" does not use the cTrader OAuth connection flow ` +
          `(cTrader-family brokers: ${CTRADER_FAMILY_BROKER_IDS.join(', ')}).`,
      );
    }
    if (!this.ctraderClient.isAvailable()) {
      throw new BadRequestException(
        'cTrader Open API application credentials are not configured on the platform — ' +
          'the OAuth connection flow cannot start. Set CTRADER_CLIENT_ID and ' +
          'CTRADER_CLIENT_SECRET (the platform cTrader app, registered via the Spotware ' +
          'partner-approval flow at openapi.ctrader.com).',
      );
    }
    const allowedRedirectUris = this.allowedRedirectUris();
    if (allowedRedirectUris.length === 0) {
      throw new BadRequestException(
        'No cTrader OAuth redirect URI is configured on the platform — set ' +
          'CTRADER_REDIRECT_URIS (the redirect URI(s) registered on the platform cTrader ' +
          'Open API application).',
      );
    }

    await this.sweepStaleFlows();

    let flow: BrokerOAuthFlow;
    if (channel === 'mobile') {
      // Finding 4: mobile authorizations IGNORE any client-supplied redirect
      // URI — the provider code must land on a REGISTERED HTTPS SERVER
      // callback (a slot URI), never on a client-controlled custom scheme.
      flow = await this.claimMobileSlotFlow(userId, brokerId);
    } else {
      const resolvedRedirectUri = redirectUri ?? allowedRedirectUris[0];
      if (!allowedRedirectUris.includes(resolvedRedirectUri)) {
        throw new BadRequestException(
          'The requested redirect URI is not registered for the platform cTrader OAuth ' +
            'application. Allowed redirect URIs are configured server-side ' +
            '(CTRADER_REDIRECT_URIS).',
        );
      }
      if (this.schemeOf(resolvedRedirectUri) !== 'https:') {
        // Honest fail-closed: custom-scheme redirects are no longer valid
        // production provider callbacks — the code must be exchanged by the
        // SERVER (web callback page or mobile callback slot route).
        throw new BadRequestException(
          'Web-channel OAuth redirect URIs must be HTTPS pages — custom app schemes are ' +
            'not production provider callbacks. Use the registered web callback page ' +
            '(default) or start a mobile-channel flow (channel="mobile").',
        );
      }
      await this.assertFlowBudget();
      flow = this.flowRepo.create({
        userId,
        brokerId,
        redirectUri: resolvedRedirectUri,
        state: 'PENDING',
        stateChangedAt: new Date(),
        expiresAt: new Date(Date.now() + FLOW_PENDING_TTL_MS),
      });
      await this.flowRepo.save(flow);
    }

    const authorizationUrl = this.ctraderClient.buildAuthorizationUrl(flow.redirectUri);

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_OAUTH_FLOW_STARTED,
      resourceType: 'BrokerConnection',
      resourceId: flow.id,
      ipAddress,
      metadata: {
        brokerId,
        // Host only — the authorization URL carries the (public) client id,
        // never the secret.
        redirectHost: this.hostOf(flow.redirectUri),
        flowExpiresAt: flow.expiresAt.toISOString(),
      },
      severity: AuditSeverity.INFO,
    });

    return {
      authorizationUrl,
      flowId: flow.id,
      expiresAt: flow.expiresAt.toISOString(),
    };
  }

  // ─── Step 3 (web): authorization-code exchange + account discovery ─────────

  async completeAuthorization(
    userId: string,
    flowId: string,
    code: string,
    ipAddress?: string,
  ): Promise<BrokerOAuthCompleteResult> {
    const flow = await this.requireOwnedFlow(flowId, userId);
    await this.sweepStaleFlows();
    if (flow.state !== 'PENDING') {
      throw new ConflictException('This broker OAuth flow is not awaiting an authorization code.');
    }
    await this.assertNotExpired(flow, 'The broker OAuth flow has expired — start again.');

    const accounts = await this.completeFlow(flow, code, userId, ipAddress);
    return { flowId, accounts };
  }

  // ─── Step 2b + 3 (mobile): SERVER-side callback → handoff token ────────────

  /**
   * Handles the UNAUTHENTICATED provider redirect for mobile flows. The flow
   * is resolved by the arriving request PATH matching a configured slot URI
   * (cTrader OAuth has no state parameter — deterministic correlation without
   * invented provider parameters). Exactly ONE PENDING unexpired flow must
   * exist for that slot: zero fails closed, more than one fails closed HARD
   * (never guess).
   */
  async handleMobileCallback(
    requestPath: string,
    code: string | undefined,
    ipAddress?: string,
  ): Promise<BrokerOAuthMobileCallbackResult> {
    await this.sweepStaleFlows();

    const slotUri = this.resolveSlotByPath(requestPath);
    if (!slotUri) {
      // Unknown callback path — indistinguishable from no pending flow.
      return { status: 'error', reason: 'unknown-or-expired' };
    }
    if (!code || code.length === 0) {
      return { status: 'error', reason: 'missing-code' };
    }

    const pending = await this.flowRepo.find({
      where: {
        redirectUri: slotUri,
        state: 'PENDING',
        expiresAt: MoreThan(new Date()),
      },
    });
    if (pending.length === 0) {
      return { status: 'error', reason: 'unknown-or-expired' };
    }
    if (pending.length > 1) {
      // Slot-claim race or manual corruption — NEVER guess which flow owns
      // the code. Fail closed hard; no exchange happens.
      this.logger.warn(
        `Ambiguous mobile OAuth callback for slot=${this.hostOf(slotUri)} — ` +
          `flows=${pending.map((f) => f.id).join(',')}`,
      );
      return { status: 'error', reason: 'ambiguous' };
    }

    const flow = pending[0];
    try {
      // The provider exchange happens SERVER-SIDE — the mobile app never
      // sees the code, the tokens, or the app secret.
      await this.completeFlow(flow, code, flow.userId, ipAddress);
    } catch (err) {
      // BadRequest (code rejected / discovery failed) or Conflict (the flow
      // was concurrently completed/consumed) — both fail closed with a clean
      // reason, no token/code material, no retry-hint data.
      this.logger.warn(
        `Mobile OAuth callback completion failed for flow=${flow.id}: ` +
          `${err instanceof Error ? err.constructor.name : 'UNKNOWN'}`,
      );
      return { status: 'error', reason: 'exchange-failed' };
    }

    // Issue the one-time handoff token (high-entropy, 120 s TTL, digest-only
    // at rest). CAS on state=AUTHORIZED — only the winner of the completion.
    const handoffToken = randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url');
    const handoffHash = this.hashHandoffToken(handoffToken);
    const issued = await this.flowRepo
      .createQueryBuilder()
      .update(BrokerOAuthFlow)
      .set({
        handoffTokenHash: handoffHash,
        handoffExpiresAt: new Date(Date.now() + HANDOFF_TOKEN_TTL_MS),
      })
      .where('id = :id AND state = :state', { id: flow.id, state: 'AUTHORIZED' })
      .execute();
    if (issued.affected !== 1) {
      return { status: 'error', reason: 'state' };
    }

    return { status: 'ok', handoffToken, flowId: flow.id };
  }

  // ─── Step 3 (mobile): single-use handoff-token exchange ────────────────────

  /**
   * Exchanges the one-time handoff token for the flow's sanitized accounts.
   * Replay, expiry, and cross-user use ALL behave as not-found (fail closed —
   * exactly one consumer ever succeeds).
   */
  async exchangeHandoffToken(
    userId: string,
    handoffToken: string,
    ipAddress?: string,
  ): Promise<BrokerOAuthHandoffResult> {
    await this.sweepStaleFlows();
    const handoffHash = this.hashHandoffToken(handoffToken);

    const flow = await this.flowRepo.findOne({
      where: {
        handoffTokenHash: handoffHash,
        state: 'AUTHORIZED',
        handoffExpiresAt: MoreThan(new Date()),
      },
    });
    if (!flow || flow.userId !== userId) {
      // Unknown, expired, replayed, or another user's token — identical
      // not-found behavior (no existence oracle).
      throw new NotFoundException(
        'Broker OAuth handoff token not found or already used — restart the connection ' +
          'in the app.',
      );
    }

    // Single-use consume: NULL the digest under a CAS on the digest itself —
    // exactly ONE concurrent consumer wins.
    const consumed = await this.flowRepo
      .createQueryBuilder()
      .update(BrokerOAuthFlow)
      .set({ handoffTokenHash: null, handoffExpiresAt: null })
      .where('id = :id AND handoff_token_hash = :hash', { id: flow.id, hash: handoffHash })
      .execute();
    if (consumed.affected !== 1) {
      throw new ConflictException('The broker OAuth handoff token has already been used.');
    }

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_OAUTH_HANDOFF_EXCHANGED,
      resourceType: 'BrokerConnection',
      resourceId: flow.id,
      ipAddress,
      metadata: { brokerId: flow.brokerId },
      severity: AuditSeverity.INFO,
    });
    this.logger.log(
      `cTrader OAuth handoff token exchanged for flow=${flow.id} broker=${flow.brokerId} ` +
        `user=${userId}`,
    );

    return { flowId: flow.id, accounts: (flow.accounts ?? []) as BrokerOAuthAccount[] };
  }

  // ─── Step 4: account linking (encrypted credential persistence) ────────────

  async linkAccount(
    userId: string,
    flowId: string,
    ctidTraderAccountId: string,
    displayName?: string,
    ipAddress?: string,
  ): Promise<BrokerConnection> {
    const flow = await this.requireOwnedFlow(flowId, userId);
    await this.sweepStaleFlows();

    const now = Date.now();
    const staleLinking =
      flow.state === 'LINKING' && flow.stateChangedAt.getTime() <= now - LINKING_STALE_MS;
    if (flow.state !== 'AUTHORIZED' && !staleLinking) {
      if (flow.state === 'PENDING') {
        throw new ConflictException('This broker OAuth flow has not completed authorization yet.');
      }
      // AUTHORIZED→LINKING in flight elsewhere, or already CONSUMED.
      throw new ConflictException(
        flow.state === 'CONSUMED'
          ? 'This broker OAuth flow has already been used — start again.'
          : 'Account linking is already in progress for this authorization.',
      );
    }
    await this.assertNotExpired(flow, 'The broker OAuth authorization has expired — start again.');

    const accounts = (flow.accounts ?? []) as BrokerOAuthAccount[];
    const account = accounts.find((a) => a.ctidTraderAccountId === ctidTraderAccountId);
    if (!account) {
      throw new BadRequestException(
        'The selected account was not granted to this authorization — complete the ' +
          'authorization flow again and choose one of the discovered accounts.',
      );
    }

    // Broker-identity validation (correction round 3, architect finding 6):
    // for broker-specific aliases the DISCOVERED brand (2149 brokerTitleShort)
    // must match the selected alias — an IC-Markets account can never link
    // under the Pepperstone alias (and vice versa). The generic 'ctrader' id
    // stays broker-agnostic. Same centralized policy as the adapter connect
    // path; fail closed with an honest, actionable message.
    if (!brokerIdentityMatches(flow.brokerId, account.brokerTitleShort)) {
      throw new BadRequestException(
        `The selected cTrader account belongs to broker ` +
          `"${account.brokerTitleShort ?? 'unknown'}" — it cannot be linked as ` +
          `"${flow.brokerId}". Choose the matching broker entry or the generic ` +
          'cTrader option, then start the authorization flow again.',
      );
    }

    // Single-use LINKING claim (CAS): exactly one concurrent linker proceeds;
    // a crashed claim becomes re-claimable after LINKING_STALE_MS.
    const claim = await this.flowRepo
      .createQueryBuilder()
      .update(BrokerOAuthFlow)
      .set({ state: 'LINKING', stateChangedAt: new Date(now) })
      .where(
        staleLinking
          ? 'id = :id AND state = :state AND state_changed_at <= :staleBoundary'
          : 'id = :id AND state = :state',
        staleLinking
          ? {
              id: flow.id,
              state: 'LINKING',
              staleBoundary: new Date(now - LINKING_STALE_MS),
            }
          : { id: flow.id, state: 'AUTHORIZED' },
      )
      .execute();
    if (claim.affected !== 1) {
      throw new ConflictException('Account linking is already in progress for this authorization.');
    }

    // Decrypt the token bundle (in-memory only; never logged/returned).
    let tokenBundle: { accessToken: string; refreshToken: string };
    try {
      tokenBundle = this.encryptionService.decryptJson({
        ciphertext: flow.tokenCiphertext!,
        iv: flow.tokenIv!,
        tag: flow.tokenTag!,
        keyId: flow.tokenKeyId!,
      }) as { accessToken: string; refreshToken: string };
    } catch (err) {
      // Fail closed: consume the flow (zero the token columns) — the stored
      // bundle is unusable and must never be retried.
      await this.casConsumeFromLinking(flow.id);
      this.logger.warn(
        `cTrader OAuth token decryption failed for flow=${flow.id}: ` +
          `${err instanceof Error ? err.constructor.name : 'UNKNOWN'}`,
      );
      throw new ConflictException(
        'The stored OAuth tokens could not be decrypted — the flow is no longer usable. ' +
          'Start the authorization flow again.',
      );
    }

    // The account's isLive flag (SERVER-DERIVED via 2149, not a client
    // assertion) decides the environment. LIVE linking for unverified
    // brokers fails closed inside createConnection exactly like the manual
    // path — OAuth NEVER weakens the production-LIVE gate.
    const dto = new ConnectBrokerDto();
    dto.brokerId = flow.brokerId;
    dto.accountType = account.isLive ? BrokerMode.LIVE : BrokerMode.DEMO;
    dto.accountId = account.ctidTraderAccountId;
    dto.apiKey = tokenBundle.accessToken;
    dto.displayName =
      displayName ??
      `${account.brokerTitleShort ?? flow.brokerId} ${account.isLive ? 'LIVE' : 'DEMO'}`;
    dto.additionalParams = {
      refreshToken: tokenBundle.refreshToken,
      accessTokenExpiresAt: flow.accessTokenExpiresAt!.toISOString(),
    };

    try {
      const connection = await this.brokerService.createConnection(dto, userId, ipAddress);
      // Single-use: the flow is consumed on successful linking (token columns
      // zeroed; expires_at=now so the sweep removes the inert row).
      const consumed = await this.casConsumeFromLinking(flow.id);
      if (consumed !== 1) {
        // Concurrent anomaly (e.g. stale-LINKING re-claim raced us) — the
        // connection EXISTS and is authoritative; the flow row is inert.
        this.logger.warn(
          `cTrader OAuth flow=${flow.id} was not in LINKING state at consume time ` +
            '(concurrent anomaly) — connection persisted, flow left inert',
        );
      }
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.BROKER_OAUTH_ACCOUNT_LINKED,
        resourceType: 'BrokerConnection',
        resourceId: connection.id,
        ipAddress,
        metadata: {
          brokerId: flow.brokerId,
          accountId: account.ctidTraderAccountId,
          accountType: dto.accountType,
          via: 'oauth',
        },
        severity: AuditSeverity.INFO,
      });
      this.logger.log(
        `cTrader OAuth account linked: connection=${connection.id} ` +
          `broker=${flow.brokerId} account=${account.ctidTraderAccountId} user=${userId}`,
      );
      return connection;
    } catch (err) {
      // LIVE-for-unverified rejections (and any other createConnection
      // failure) propagate — the flow is restored to AUTHORIZED so the user
      // can pick a DEMO account from the same authorization instead.
      await this.casRestoreLinkingToAuthorized(flow.id);
      this.logger.warn(
        `cTrader OAuth link failed for flow=${flowId}: ${err instanceof Error ? err.constructor.name : 'UNKNOWN'}`,
      );
      throw err;
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Shared completion: exchange the provider code with the flow's redirect
   * URI, discover the granted accounts, and CAS the flow PENDING → AUTHORIZED
   * with the ENCRYPTED token bundle. Returns the sanitized account list.
   */
  private async completeFlow(
    flow: BrokerOAuthFlow,
    code: string,
    actorUserId: string,
    ipAddress?: string,
  ): Promise<BrokerOAuthAccount[]> {
    let tokens: CtraderOAuthTokens;
    try {
      tokens = await this.ctraderClient.exchangeAuthorizationCode(code, flow.redirectUri);
    } catch (err) {
      // The authorization code is single-use at Spotware and this flow's code
      // is now spent (or was invalid) — the flow is DEAD: consume it so it
      // can never be retried with a replayed code (fail-closed).
      await this.casDeletePending(flow.id);
      const providerCode = err instanceof BrokerAdapterError ? err.code : BrokerErrorCode.UNKNOWN;
      await this.auditService.log({
        actorUserId,
        action: AuditAction.BROKER_OAUTH_AUTHORIZATION_FAILED,
        resourceType: 'BrokerConnection',
        resourceId: flow.id,
        ipAddress,
        metadata: { brokerId: flow.brokerId, providerErrorCode: providerCode },
        severity: AuditSeverity.WARNING,
      });
      this.logger.warn(
        `cTrader OAuth code exchange failed for flow=${flow.id} broker=${flow.brokerId} ` +
          `code=${providerCode}`,
      );
      throw new BadRequestException(
        'The cTrader authorization code was rejected (it is single-use and expires in 60 ' +
          'seconds) — start the authorization flow again.',
      );
    }

    // Account discovery (2149): every cTID account granted to this token.
    let discovered: CtraderDiscoveredAccount[];
    try {
      discovered = await this.ctraderClient.discoverAccounts('DEMO', tokens.accessToken);
    } catch (err) {
      await this.casDeletePending(flow.id);
      const providerCode = err instanceof BrokerAdapterError ? err.code : BrokerErrorCode.UNKNOWN;
      await this.auditService.log({
        actorUserId,
        action: AuditAction.BROKER_OAUTH_AUTHORIZATION_FAILED,
        resourceType: 'BrokerConnection',
        resourceId: flow.id,
        ipAddress,
        metadata: { brokerId: flow.brokerId, providerErrorCode: providerCode },
        severity: AuditSeverity.WARNING,
      });
      this.logger.warn(
        `cTrader OAuth account discovery failed for flow=${flow.id} ` +
          `broker=${flow.brokerId} code=${providerCode}`,
      );
      throw new BadRequestException(
        'cTrader account discovery failed for the authorized token — start the ' +
          'authorization flow again.',
      );
    }

    const accounts: BrokerOAuthAccount[] = discovered.map((account) => ({
      ctidTraderAccountId: String(account.ctidTraderAccountId),
      isLive: account.isLive,
      ...(account.traderLogin !== undefined ? { traderLogin: account.traderLogin } : {}),
      ...(account.brokerTitleShort !== undefined
        ? { brokerTitleShort: account.brokerTitleShort }
        : {}),
    }));

    // Tokens are persisted ONLY as AES-256-GCM ciphertext (the store is
    // durable/shared) and are NEVER returned or logged.
    const tokenBundle = this.encryptionService.encryptJson({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
    const now = Date.now();
    const accessTokenExpiresAt = new Date(now + tokens.expiresIn * 1000);

    // CAS PENDING → AUTHORIZED: exactly one winner — a concurrently
    // completed/consumed flow (e.g. authorization-code replay across
    // replicas) fails closed here.
    const updated = await this.flowRepo
      .createQueryBuilder()
      .update(BrokerOAuthFlow)
      .set({
        state: 'AUTHORIZED',
        tokenCiphertext: tokenBundle.ciphertext,
        tokenIv: tokenBundle.iv,
        tokenTag: tokenBundle.tag,
        tokenKeyId: tokenBundle.keyId,
        accessTokenExpiresAt,
        accounts,
        expiresAt: new Date(now + FLOW_AUTHORIZED_TTL_MS),
        completedAt: new Date(now),
        stateChangedAt: new Date(now),
      })
      .where('id = :id AND state = :state', { id: flow.id, state: 'PENDING' })
      .execute();
    if (updated.affected !== 1) {
      throw new ConflictException(
        'The broker OAuth flow is no longer awaiting an authorization code.',
      );
    }

    await this.auditService.log({
      actorUserId,
      action: AuditAction.BROKER_OAUTH_AUTHORIZATION_COMPLETED,
      resourceType: 'BrokerConnection',
      resourceId: flow.id,
      ipAddress,
      metadata: {
        brokerId: flow.brokerId,
        accountCount: accounts.length,
        liveAccountCount: accounts.filter((a) => a.isLive).length,
        demoAccountCount: accounts.filter((a) => !a.isLive).length,
        accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      },
      severity: AuditSeverity.INFO,
    });
    this.logger.log(
      `cTrader OAuth authorization completed for flow=${flow.id} broker=${flow.brokerId} ` +
        `user=${actorUserId} (accounts=${accounts.length})`,
    );

    return accounts;
  }

  /**
   * Atomically claims a FREE mobile callback slot and inserts the PENDING
   * flow bound to it. A slot is free when NO unexpired PENDING flow holds its
   * redirect URI. After the insert, a re-query narrows the cross-replica race:
   * if another replica raced us onto the same slot, OUR row is deleted and
   * the next slot is tried (the callback-side exactly-one check is the hard
   * backstop). With a single configured slot, mobile authorizations serialize
   * platform-wide (operators register more slots for parallelism).
   */
  private async claimMobileSlotFlow(userId: string, brokerId: string): Promise<BrokerOAuthFlow> {
    const slots = this.mobileCallbackUris();
    if (slots.length === 0) {
      throw new BadRequestException(
        'No mobile OAuth callback slot URI is configured on the platform — set ' +
          'CTRADER_MOBILE_CALLBACK_URIS to the HTTPS server callback URI(s) registered on ' +
          'the platform cTrader Open API application (e.g. ' +
          'https://api.irexpro.com/api/v1/broker/connections/oauth/callback/m1). ' +
          'Register several distinct URIs for parallel mobile authorizations.',
      );
    }

    await this.assertFlowBudget();

    const now = () => new Date();
    for (const slot of slots) {
      const busy = await this.flowRepo.count({
        where: { redirectUri: slot, state: 'PENDING', expiresAt: MoreThan(now()) },
      });
      if (busy > 0) continue;

      const flow = this.flowRepo.create({
        userId,
        brokerId,
        redirectUri: slot,
        state: 'PENDING',
        stateChangedAt: now(),
        expiresAt: new Date(Date.now() + FLOW_PENDING_TTL_MS),
      });
      await this.flowRepo.save(flow);

      // Race guard: another replica may have claimed the same slot between
      // the count and the insert. Abandon OUR row and try the next slot.
      const after = await this.flowRepo.count({
        where: { redirectUri: slot, state: 'PENDING', expiresAt: MoreThan(now()) },
      });
      if (after > 1) {
        await this.flowRepo.delete({ id: flow.id });
        continue;
      }
      return flow;
    }
    throw new ConflictException('All mobile OAuth callback slots are busy — retry in a moment.');
  }

  /** Ownership-checked, single-tenant flow lookup (no existence oracle). */
  private async requireOwnedFlow(flowId: string, userId: string): Promise<BrokerOAuthFlow> {
    const flow = await this.flowRepo.findOne({ where: { id: flowId } });
    if (!flow || flow.userId !== userId) {
      // NotFound for BOTH unknown and foreign flows — no existence oracle.
      throw new NotFoundException('Broker OAuth flow not found — start again.');
    }
    return flow;
  }

  /** Expired flows fail closed and are deleted (bounded store). */
  private async assertNotExpired(flow: BrokerOAuthFlow, message: string): Promise<void> {
    if (flow.expiresAt.getTime() <= Date.now()) {
      await this.flowRepo.delete({ id: flow.id });
      throw new ConflictException(message);
    }
  }

  /** Bounded store: at most MAX_CONCURRENT_FLOWS live (non-CONSUMED) rows. */
  private async assertFlowBudget(): Promise<void> {
    const live = await this.flowRepo.count({
      where: { state: Not('CONSUMED'), expiresAt: MoreThan(new Date()) },
    });
    if (live >= MAX_CONCURRENT_FLOWS) {
      throw new ConflictException(
        'Too many concurrent broker OAuth flows — retry in a few minutes.',
      );
    }
  }

  /** Lazy sweep: delete rows whose expires_at is older than the grace horizon. */
  private async sweepStaleFlows(): Promise<void> {
    try {
      await this.flowRepo
        .createQueryBuilder()
        .delete()
        .from(BrokerOAuthFlow)
        .where('expires_at < :cutoff', { cutoff: new Date(Date.now() - FLOW_SWEEP_GRACE_MS) })
        .execute();
    } catch (err) {
      // Best-effort housekeeping — never block the request path.
      this.logger.warn(
        `Broker OAuth flow sweep failed: ${err instanceof Error ? err.constructor.name : 'UNKNOWN'}`,
      );
    }
  }

  /** CAS-delete a PENDING flow (fail-closed: no replay window). */
  private async casDeletePending(flowId: string): Promise<void> {
    await this.flowRepo
      .createQueryBuilder()
      .delete()
      .from(BrokerOAuthFlow)
      .where('id = :id AND state = :state', { id: flowId, state: 'PENDING' })
      .execute();
  }

  /**
   * CAS LINKING → CONSUMED: zero the token columns and accounts, mark
   * consumed, and pull expires_at to now (the sweep removes the inert row).
   * Returns the affected-rows count.
   */
  private async casConsumeFromLinking(flowId: string): Promise<number | undefined> {
    const result = await this.flowRepo
      .createQueryBuilder()
      .update(BrokerOAuthFlow)
      .set({
        state: 'CONSUMED',
        consumedAt: new Date(),
        stateChangedAt: new Date(),
        tokenCiphertext: null,
        tokenIv: null,
        tokenTag: null,
        tokenKeyId: null,
        accessTokenExpiresAt: null,
        accounts: null,
        expiresAt: new Date(),
      })
      .where('id = :id AND state = :state', { id: flowId, state: 'LINKING' })
      .execute();
    return result.affected;
  }

  /** CAS LINKING → AUTHORIZED (restore after a failed createConnection). */
  private async casRestoreLinkingToAuthorized(flowId: string): Promise<void> {
    await this.flowRepo
      .createQueryBuilder()
      .update(BrokerOAuthFlow)
      .set({ state: 'AUTHORIZED', stateChangedAt: new Date() })
      .where('id = :id AND state = :state', { id: flowId, state: 'LINKING' })
      .execute();
  }

  /** SHA-256 hex digest of the handoff token (never the token itself). */
  private hashHandoffToken(handoffToken: string): string {
    return createHash('sha256').update(handoffToken, 'utf8').digest('hex');
  }

  /** Resolves the configured mobile slot URI whose path matches the request. */
  private resolveSlotByPath(requestPath: string): string | null {
    const normalized = requestPath.split('?')[0];
    return (
      this.mobileCallbackUris().find((uri) => {
        try {
          return new URL(uri).pathname === normalized;
        } catch {
          return false;
        }
      }) ?? null
    );
  }

  /** Server-configured redirect URI allowlist (comma-separated env). */
  private allowedRedirectUris(): string[] {
    const raw = this.configService.get<string>('broker.ctraderRedirectUris', '') ?? '';
    return raw
      .split(',')
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);
  }

  /** Server-configured mobile callback slot URIs (comma-separated env). */
  private mobileCallbackUris(): string[] {
    const raw = this.configService.get<string>('broker.ctraderMobileCallbackUris', '') ?? '';
    return raw
      .split(',')
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);
  }

  private schemeOf(uri: string): string {
    try {
      return new URL(uri).protocol;
    } catch {
      return '';
    }
  }

  private hostOf(uri: string): string {
    try {
      return new URL(uri).host;
    } catch {
      return 'invalid-uri';
    }
  }
}
