import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { BrokerConnection } from '../entities/broker-connection.entity';
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

/** Lifetime of a PENDING flow (authorization not yet completed). */
const FLOW_PENDING_TTL_MS = 10 * 60_000;
/** Lifetime of an AUTHORIZED flow (tokens held in memory until linked). */
const FLOW_AUTHORIZED_TTL_MS = 5 * 60_000;
/** Bounded flow store — at most this many concurrent flows process-wide. */
const MAX_CONCURRENT_FLOWS = 1000;

/** Sanitized discovered account (returned to the client — NO token material). */
export interface BrokerOAuthAccount {
  ctidTraderAccountId: string;
  isLive: boolean;
  traderLogin?: number;
  brokerTitleShort?: string;
}

interface OAuthFlowRecord {
  flowId: string;
  userId: string;
  brokerId: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  state: 'PENDING' | 'AUTHORIZED';
  /** Token material — MEMORY-ONLY, exists solely between complete and link. */
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  accounts?: BrokerOAuthAccount[];
}

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

/**
 * BrokerOAuthService — the user-facing cTrader OAuth connection flow
 * (Sprint 56 correction round 1 / audit point 6).
 *
 * THE FLOW (end-to-end):
 *   1. POST /broker/connections/oauth/authorize (authenticated)
 *      → server creates a SINGLE-USE server-side flow record (flowId bound to
 *        the requesting user) and returns the official id.ctrader.com consent
 *        URL. The frontend redirects the user there in an EXTERNAL
 *        browser/system browser — iRexPro NEVER sees the cTrader password.
 *   2. The user grants access at cTrader; Spotware redirects the user's
 *      browser to the platform's registered redirect URI carrying the
 *      single-use authorization code (TTL 60 s). cTrader's OAuth supports NO
 *      state parameter — correlation is maintained SERVER-SIDE by the flowId
 *      (the frontend keeps its copy in session storage and presents it with
 *      the code).
 *   3. POST /broker/connections/oauth/complete { flowId, code }
 *      → the server validates flow ownership/single-use/TTL, exchanges the
 *      code with the PLATFORM application credentials (never user-supplied
 *      app credentials), discovers every cTID account granted to the token
 *      (ProtoOAGetAccountListByAccessTokenReq — isLive flags decide DEMO vs
 *      LIVE), and returns the sanitized account list. Tokens stay in the
 *      memory-only flow record.
 *   4. POST /broker/connections/oauth/link { flowId, ctidTraderAccountId }
 *      → the chosen account is linked through the CANONICAL
 *      BrokerService.createConnection path: credentials (access token +
 *      refresh token + expiry tracking) are AES-256-GCM encrypted, the
 *      account type derives from the account's isLive flag, and LIVE linking
 *      for unverified brokers fails closed exactly like the manual path
 *      (production-LIVE verification is NOT weakened by OAuth). The flow is
 *      consumed (single-use).
 *
 * SECURITY INVARIANTS (adversarially tested):
 * - Flow correlation is SERVER-SIDE and SINGLE-USE: a flowId completes/links
 *   exactly once, belongs to exactly one user, and expires.
 * - Application credentials (CTRADER_CLIENT_ID/SECRET) are server-only —
 *   users never supply or receive them.
 * - Access/refresh tokens NEVER appear in responses, audit metadata, logs,
 *   exception text, or any plaintext-at-rest field; between complete and
 *   link they live ONLY in the in-memory flow record (bounded TTL).
 * - The flow store is BOUNDED (MAX_CONCURRENT_FLOWS) with lazy TTL sweeps.
 */
@Injectable()
export class BrokerOAuthService {
  private readonly logger = new Logger(BrokerOAuthService.name);
  private readonly flows = new Map<string, OAuthFlowRecord>();

  constructor(
    private readonly brokerService: BrokerService,
    private readonly ctraderClient: CTraderClientService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Step 1: authorization start ───────────────────────────────────────────

  async startAuthorization(
    userId: string,
    brokerId: string,
    ipAddress?: string,
    redirectUri?: string,
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
    const resolvedRedirectUri = redirectUri ?? allowedRedirectUris[0];
    if (!allowedRedirectUris.includes(resolvedRedirectUri)) {
      throw new BadRequestException(
        'The requested redirect URI is not registered for the platform cTrader OAuth ' +
          'application. Allowed redirect URIs are configured server-side ' +
          '(CTRADER_REDIRECT_URIS).',
      );
    }

    this.sweepExpiredFlows();
    if (this.flows.size >= MAX_CONCURRENT_FLOWS) {
      throw new ConflictException(
        'Too many concurrent broker OAuth flows — retry in a few minutes.',
      );
    }

    const flowId = randomUUID();
    const now = Date.now();
    this.flows.set(flowId, {
      flowId,
      userId,
      brokerId,
      redirectUri: resolvedRedirectUri,
      createdAt: now,
      expiresAt: now + FLOW_PENDING_TTL_MS,
      state: 'PENDING',
    });

    const authorizationUrl = this.ctraderClient.buildAuthorizationUrl(resolvedRedirectUri);

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_OAUTH_FLOW_STARTED,
      resourceType: 'BrokerConnection',
      resourceId: flowId,
      ipAddress,
      metadata: {
        brokerId,
        // Host only — the authorization URL carries the (public) client id,
        // never the secret.
        redirectHost: this.hostOf(resolvedRedirectUri),
        flowExpiresAt: new Date(now + FLOW_PENDING_TTL_MS).toISOString(),
      },
      severity: AuditSeverity.INFO,
    });

    return {
      authorizationUrl,
      flowId,
      expiresAt: new Date(now + FLOW_PENDING_TTL_MS).toISOString(),
    };
  }

  // ─── Step 3: authorization-code exchange + account discovery ───────────────

  async completeAuthorization(
    userId: string,
    flowId: string,
    code: string,
    ipAddress?: string,
  ): Promise<BrokerOAuthCompleteResult> {
    const flow = this.requireOwnedFlow(flowId, userId, 'PENDING');
    this.sweepExpiredFlows();
    if (flow.expiresAt <= Date.now()) {
      this.flows.delete(flowId);
      throw new ConflictException('The broker OAuth flow has expired — start again.');
    }

    let tokens: CtraderOAuthTokens;
    try {
      tokens = await this.ctraderClient.exchangeAuthorizationCode(code, flow.redirectUri);
    } catch (err) {
      // The authorization code is single-use at Spotware and this flow's code
      // is now spent (or was invalid) — the flow is DEAD: consume it so it
      // can never be retried with a replayed code (fail-closed).
      this.flows.delete(flowId);
      const providerCode = err instanceof BrokerAdapterError ? err.code : BrokerErrorCode.UNKNOWN;
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.BROKER_OAUTH_AUTHORIZATION_FAILED,
        resourceType: 'BrokerConnection',
        resourceId: flowId,
        ipAddress,
        metadata: { brokerId: flow.brokerId, providerErrorCode: providerCode },
        severity: AuditSeverity.WARNING,
      });
      this.logger.warn(
        `cTrader OAuth code exchange failed for flow=${flowId} broker=${flow.brokerId} ` +
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
      this.flows.delete(flowId);
      const providerCode = err instanceof BrokerAdapterError ? err.code : BrokerErrorCode.UNKNOWN;
      await this.auditService.log({
        actorUserId: userId,
        action: AuditAction.BROKER_OAUTH_AUTHORIZATION_FAILED,
        resourceType: 'BrokerConnection',
        resourceId: flowId,
        ipAddress,
        metadata: { brokerId: flow.brokerId, providerErrorCode: providerCode },
        severity: AuditSeverity.WARNING,
      });
      this.logger.warn(
        `cTrader OAuth account discovery failed for flow=${flowId} ` +
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

    // Tokens held MEMORY-ONLY until link (bounded TTL), never returned.
    flow.state = 'AUTHORIZED';
    flow.accessToken = tokens.accessToken;
    flow.refreshToken = tokens.refreshToken;
    flow.accessTokenExpiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
    flow.accounts = accounts;
    flow.expiresAt = Date.now() + FLOW_AUTHORIZED_TTL_MS;

    await this.auditService.log({
      actorUserId: userId,
      action: AuditAction.BROKER_OAUTH_AUTHORIZATION_COMPLETED,
      resourceType: 'BrokerConnection',
      resourceId: flowId,
      ipAddress,
      metadata: {
        brokerId: flow.brokerId,
        accountCount: accounts.length,
        liveAccountCount: accounts.filter((a) => a.isLive).length,
        demoAccountCount: accounts.filter((a) => !a.isLive).length,
        accessTokenExpiresAt: flow.accessTokenExpiresAt,
      },
      severity: AuditSeverity.INFO,
    });
    this.logger.log(
      `cTrader OAuth authorization completed for flow=${flowId} broker=${flow.brokerId} ` +
        `user=${userId} (accounts=${accounts.length})`,
    );

    return { flowId, accounts };
  }

  // ─── Step 4: account linking (encrypted credential persistence) ────────────

  async linkAccount(
    userId: string,
    flowId: string,
    ctidTraderAccountId: string,
    displayName?: string,
    ipAddress?: string,
  ): Promise<BrokerConnection> {
    const flow = this.requireOwnedFlow(flowId, userId, 'AUTHORIZED');
    this.sweepExpiredFlows();
    if (flow.expiresAt <= Date.now()) {
      this.flows.delete(flowId);
      throw new ConflictException('The broker OAuth authorization has expired — start again.');
    }
    const account = (flow.accounts ?? []).find(
      (a) => a.ctidTraderAccountId === ctidTraderAccountId,
    );
    if (!account) {
      throw new BadRequestException(
        'The selected account was not granted to this authorization — complete the ' +
          'authorization flow again and choose one of the discovered accounts.',
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
    dto.apiKey = flow.accessToken;
    dto.displayName =
      displayName ??
      `${account.brokerTitleShort ?? flow.brokerId} ${account.isLive ? 'LIVE' : 'DEMO'}`;
    dto.additionalParams = {
      refreshToken: flow.refreshToken!,
      accessTokenExpiresAt: flow.accessTokenExpiresAt!,
    };

    try {
      const connection = await this.brokerService.createConnection(dto, userId, ipAddress);
      // Single-use: the flow is consumed on successful linking.
      this.deleteFlow(flowId);
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
      // failure) propagate — the flow stays AUTHORIZED so the user can pick
      // a DEMO account from the same authorization instead.
      this.logger.warn(
        `cTrader OAuth link failed for flow=${flowId}: ${err instanceof Error ? err.constructor.name : 'UNKNOWN'}`,
      );
      throw err;
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Ownership-checked, state-checked, single-tenant flow lookup. */
  private requireOwnedFlow(
    flowId: string,
    userId: string,
    state: 'PENDING' | 'AUTHORIZED',
  ): OAuthFlowRecord {
    const flow = this.flows.get(flowId);
    if (!flow || flow.userId !== userId) {
      // NotFound for BOTH unknown and foreign flows — no existence oracle.
      throw new NotFoundException('Broker OAuth flow not found — start again.');
    }
    if (flow.state !== state) {
      throw new ConflictException(
        state === 'PENDING'
          ? 'This broker OAuth flow is not awaiting an authorization code.'
          : 'This broker OAuth flow has not completed authorization yet.',
      );
    }
    return flow;
  }

  private deleteFlow(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (flow) {
      // Zero the memory-held token material before dropping the record.
      flow.accessToken = undefined;
      flow.refreshToken = undefined;
      flow.accessTokenExpiresAt = undefined;
      flow.accounts = undefined;
    }
    this.flows.delete(flowId);
  }

  private sweepExpiredFlows(): void {
    const now = Date.now();
    for (const [flowId, flow] of this.flows) {
      if (flow.expiresAt <= now) {
        this.deleteFlow(flowId);
      }
    }
  }

  /** Server-configured redirect URI allowlist (comma-separated env). */
  private allowedRedirectUris(): string[] {
    const raw = this.configService.get<string>('broker.ctraderRedirectUris', '') ?? '';
    return raw
      .split(',')
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);
  }

  private hostOf(uri: string): string {
    try {
      return new URL(uri).host;
    } catch {
      return 'invalid-uri';
    }
  }
}
