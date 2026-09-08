import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { BrokerAccount } from '../broker/entities/broker-account.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerService } from '../broker/broker.service';
import { BrokerMode, BrokerConnectionStatus } from '../broker/interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from '../broker/authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../broker/authorization/broker-credential-status';
import { Trade, TradeStatus } from '../execution/entities/trade.entity';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { Order } from '../execution/orders/order.entity';
import { OrderStatus } from '../execution/orders/order.enums';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from '../execution/reconciliation/entities/reconciliation-discrepancy.entity';
import {
  ReconciliationDiscrepancySeverity,
  ReconciliationDiscrepancyStatus,
} from '../execution/reconciliation/reconciliation.enums';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import {
  LiveAccountAlertKind,
  LiveAccountAlertSeverity,
  LiveAccountEnvironment,
  LiveAutomationStatus,
  LiveConnectionHealth,
  LiveOrderStatusFilter,
} from './dto/live-account.enums';
import {
  LiveAccountAlertViewDto,
  LiveAccountConnectionViewDto,
  LiveAccountFinancialSummaryDto,
  LiveAccountOverviewResponseDto,
  LiveAutomationSummaryDto,
  LiveExecutionHealthSummaryDto,
  LiveReconciliationSummaryDto,
} from './dto/live-account-overview-response.dto';
import {
  LiveAccountOrdersPageDto,
  toLiveOrderRowView,
} from './dto/live-account-orders-response.dto';
import {
  LiveAccountPositionsViewDto,
  LivePositionRowViewDto,
  accountTypeToEnvironment,
  toLivePositionRowView,
} from './dto/live-account-positions-response.dto';
import {
  LiveAccountActivityPageDto,
  toLiveActivityRowView,
} from './dto/live-account-activity-response.dto';

// ─── Public constants (Directive-tuned thresholds) ──────────────────────────

/** Default page size for orders/activity listings. */
export const LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT = 50;
/** Maximum page size for orders/activity listings. */
export const LIVE_ACCOUNT_MAX_PAGE_LIMIT = 100;
/** Terminal-order window for rejectedLast24h / filledLast24h. */
export const LIVE_ACCOUNT_TERMINAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** financial.syncedAt older than this → connection health DEGRADED. */
export const LIVE_ACCOUNT_FINANCIAL_STALE_MS = 24 * 60 * 60 * 1000;
/** CONNECTED connection with financial null / syncedAt older → ACCOUNT_SYNC_STALE alert. */
export const LIVE_ACCOUNT_SYNC_STALE_ALERT_MS = 60 * 60 * 1000;
/** Sanitized lastErrorMessage never exceeds this length. */
export const LIVE_ACCOUNT_ERROR_MESSAGE_MAX_LENGTH = 200;

/** WORKING filter = orders still in flight (incl. reconciliation-held). */
export const ORDER_WORKING_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CREATED,
  OrderStatus.SUBMITTED,
  OrderStatus.ACKNOWLEDGED,
  OrderStatus.PARTIALLY_FILLED,
  OrderStatus.RECONCILIATION_PENDING,
];

/** HISTORY filter = terminal order states. */
export const ORDER_HISTORY_STATUSES: readonly OrderStatus[] = [
  OrderStatus.FILLED,
  OrderStatus.REJECTED,
  OrderStatus.CANCELLED,
  OrderStatus.EXPIRED,
];

const ORDER_STATUS_FILTERS: Readonly<
  Record<Exclude<LiveOrderStatusFilter, 'ALL'>, readonly OrderStatus[]>
> = {
  [LiveOrderStatusFilter.WORKING]: ORDER_WORKING_STATUSES,
  [LiveOrderStatusFilter.HISTORY]: ORDER_HISTORY_STATUSES,
};

const ALERT_SEVERITY_RANK: Readonly<Record<LiveAccountAlertSeverity, number>> = {
  [LiveAccountAlertSeverity.CRITICAL]: 0,
  [LiveAccountAlertSeverity.WARNING]: 1,
  [LiveAccountAlertSeverity.INFO]: 2,
};

/** Alphanumeric runs of 16+ chars are treated as key/token material (Directive §40). */
const SECRET_LIKE_RUN = /[A-Za-z0-9]{16,}/g;

// ─── Pure helpers (exported for reuse by the controller + tests) ────────────

export function clampPaginationLimit(limit: number): number {
  const truncated = Math.trunc(Number.isFinite(limit) ? limit : LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT);
  return Math.min(Math.max(truncated, 1), LIVE_ACCOUNT_MAX_PAGE_LIMIT);
}

export function clampPaginationOffset(offset: number): number {
  const truncated = Math.trunc(Number.isFinite(offset) ? offset : 0);
  return Math.max(truncated, 0);
}

/** Only exact WORKING / HISTORY pass; anything else safely falls back to ALL. */
export function normalizeOrderStatusFilter(
  status: LiveOrderStatusFilter | string | null | undefined,
): LiveOrderStatusFilter {
  if (status === LiveOrderStatusFilter.WORKING || status === LiveOrderStatusFilter.HISTORY) {
    return status;
  }
  return LiveOrderStatusFilter.ALL;
}

/** Masked account identifier: ONLY the last 4 characters, prefixed "•••". */
export function maskAccountId(accountId: string | null | undefined): string | null {
  if (!accountId || accountId.length < 4) return null;
  return `•••${accountId.slice(-4)}`;
}

/** Truncate + strip secret-looking runs from a raw provider error message. */
export function sanitizeErrorMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const scrubbed = message.replace(SECRET_LIKE_RUN, '…');
  const trimmed =
    scrubbed.length > LIVE_ACCOUNT_ERROR_MESSAGE_MAX_LENGTH
      ? scrubbed.slice(0, LIVE_ACCOUNT_ERROR_MESSAGE_MAX_LENGTH)
      : scrubbed;
  return trimmed.length > 0 ? trimmed : null;
}

function toIsoString(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

interface OpenDiscrepancyCounts {
  total: number;
  critical: number;
  warning: number;
}

interface ConnectionContext {
  brokerName: string;
  accountType: BrokerMode;
}

/**
 * LiveAccountService — read-only aggregation over PR-1..PR-4 state
 * (Sprint 50 PR-5 — Directive PHASE J "User API").
 *
 * TENANT ISOLATION (Directive §40): every query is scoped by the authenticated
 * user's UUID. No client-supplied userId / connectionId / accountId is ever
 * accepted as an input. The only cross-user surface (BrokerAccount) is scoped
 * via the user's OWN connection ids resolved from a user-scoped query.
 *
 * SECURITY (read-only projection by construction): credential material
 * (`encryptedCredentials`, `credentialIv`, `credentialTag`, `encryptionKeyId`)
 * never enters any DTO; `lastErrorMessage` is sanitized + truncated; audit
 * `metadata` is never surfaced; the Sprint 50 fail-closed executable gate is
 * REUSED via BrokerService.isConnectionExecutable (never re-implemented).
 */
@Injectable()
export class LiveAccountService {
  constructor(
    @InjectRepository(BrokerConnection)
    private readonly connectionRepo: Repository<BrokerConnection>,
    @InjectRepository(BrokerAccount)
    private readonly accountRepo: Repository<BrokerAccount>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(TradingSession)
    private readonly sessionRepo: Repository<TradingSession>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(ReconciliationRun)
    private readonly runRepo: Repository<ReconciliationRun>,
    @InjectRepository(ReconciliationDiscrepancy)
    private readonly discrepancyRepo: Repository<ReconciliationDiscrepancy>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(RiskProfile)
    private readonly riskProfileRepo: Repository<RiskProfile>,
    private readonly brokerService: BrokerService,
  ) {}

  // ─── GET /live-account/overview ───────────────────────────────────────────

  async getOverview(
    userId: string,
    now: Date = new Date(),
  ): Promise<LiveAccountOverviewResponseDto> {
    const connections = await this.connectionRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    const [accounts, reconciliationRows, session, riskProfile, executionHealth] = await Promise.all(
      [
        this.loadAccountsForConnections(connections),
        this.loadOpenDiscrepancyRows(userId),
        this.findLatestSession(userId),
        this.riskProfileRepo.findOne({ where: { userId } }),
        this.loadExecutionHealth(userId, now),
      ],
    );

    const accountByConnection = new Map(
      accounts.map((account) => [account.brokerConnectionId, account]),
    );
    const openDiscrepancyCounts = this.groupOpenDiscrepancies(reconciliationRows.rows);

    // Phase F partial-failure tri-state: the latest-run lookups are guarded
    // individually — a failed lookup degrades to `reconciliationLoaded: false`
    // (never to a confident "zero discrepancies" rendering).
    let runLookupsLoaded = true;
    const connectionViews = await Promise.all(
      connections.map(async (connection) => {
        let lastRun: ReconciliationRun | null = null;
        try {
          lastRun = await this.runRepo.findOne({
            where: { userId, brokerConnectionId: connection.id },
            order: { startedAt: 'DESC', createdAt: 'DESC' },
          });
        } catch {
          runLookupsLoaded = false;
        }
        return this.toConnectionView(
          connection,
          accountByConnection.get(connection.id),
          lastRun,
          openDiscrepancyCounts.get(connection.id),
          now,
        );
      }),
    );

    const automation = this.toAutomationSummary(session, riskProfile);
    const alerts = this.deriveAlerts(connections, connectionViews, automation, now);

    return {
      generatedAt: now.toISOString(),
      connections: connectionViews,
      automation,
      executionHealth,
      alerts,
      environment: this.deriveEnvironment(connections),
      hasConnections: connections.length > 0,
      reconciliationLoaded: reconciliationRows.loaded && runLookupsLoaded,
    };
  }

  // ─── GET /live-account/orders ─────────────────────────────────────────────

  async getOrders(
    userId: string,
    status: LiveOrderStatusFilter | string | null | undefined = LiveOrderStatusFilter.ALL,
    limit: number = LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT,
    offset: number = 0,
  ): Promise<LiveAccountOrdersPageDto> {
    const filter = normalizeOrderStatusFilter(status);
    const safeLimit = clampPaginationLimit(limit);
    const safeOffset = clampPaginationOffset(offset);

    const where: FindOptionsWhere<Order> =
      filter === LiveOrderStatusFilter.ALL
        ? { userId }
        : { userId, status: In([...ORDER_STATUS_FILTERS[filter]]) };

    const [orders, total, connectionContext] = await Promise.all([
      this.orderRepo.find({
        where,
        order: { createdAt: 'DESC' },
        take: safeLimit,
        skip: safeOffset,
      }),
      this.orderRepo.count({ where }),
      this.loadConnectionContext(userId),
    ]);

    return {
      orders: orders.map((order) =>
        toLiveOrderRowView(
          order,
          connectionContext.get(order.brokerConnectionId)?.brokerName ?? null,
        ),
      ),
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  // ─── GET /live-account/positions ──────────────────────────────────────────

  async getPositions(userId: string): Promise<LiveAccountPositionsViewDto> {
    const where: FindOptionsWhere<Trade> = {
      userId,
      status: In([TradeStatus.OPEN, TradeStatus.RECONCILIATION_PENDING]),
    };

    const [trades, total, connectionContext] = await Promise.all([
      this.tradeRepo.find({
        where,
        order: { openedAt: 'DESC', createdAt: 'DESC' },
      }),
      this.tradeRepo.count({ where }),
      this.loadConnectionContext(userId),
    ]);

    const positions: LivePositionRowViewDto[] = trades.map((trade) => {
      const context = connectionContext.get(trade.brokerConnectionId);
      return toLivePositionRowView(
        trade,
        context?.brokerName ?? null,
        accountTypeToEnvironment(context?.accountType),
      );
    });

    return { positions, total };
  }

  // ─── GET /live-account/activity ───────────────────────────────────────────

  async getActivity(
    userId: string,
    limit: number = LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT,
    offset: number = 0,
  ): Promise<LiveAccountActivityPageDto> {
    const safeLimit = clampPaginationLimit(limit);
    const safeOffset = clampPaginationOffset(offset);
    const where: FindOptionsWhere<AuditLog> = { actorUserId: userId };

    const [logs, total] = await Promise.all([
      this.auditRepo.find({
        where,
        order: { createdAt: 'DESC' },
        take: safeLimit,
        skip: safeOffset,
      }),
      this.auditRepo.count({ where }),
    ]);

    return {
      activity: logs.map(toLiveActivityRowView),
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  // ─── Private loaders (all tenant-scoped) ───────────────────────────────────

  /**
   * BrokerAccount rows for the user's OWN connections (the table has no userId
   * column — scoping happens through the connection ids resolved above).
   */
  private async loadAccountsForConnections(
    connections: BrokerConnection[],
  ): Promise<BrokerAccount[]> {
    if (connections.length === 0) return [];
    const connectionIds = connections.map((connection) => connection.id);
    return this.accountRepo.find({ where: { brokerConnectionId: In(connectionIds) } });
  }

  private async loadConnectionContext(userId: string): Promise<Map<string, ConnectionContext>> {
    const connections = await this.connectionRepo.find({ where: { userId } });
    return new Map(
      connections.map((connection) => [
        connection.id,
        { brokerName: connection.brokerName, accountType: connection.accountType },
      ]),
    );
  }

  /**
   * Open discrepancy rows for the user, with a load tri-state: `loaded` is
   * false when the LOOKUP itself failed (rows are then empty — callers must
   * not interpret that as "zero discrepancies").
   */
  private async loadOpenDiscrepancyRows(
    userId: string,
  ): Promise<{ rows: ReconciliationDiscrepancy[]; loaded: boolean }> {
    try {
      const rows = await this.discrepancyRepo.find({
        where: { userId, status: ReconciliationDiscrepancyStatus.OPEN },
      });
      return { rows, loaded: true };
    } catch {
      return { rows: [], loaded: false };
    }
  }

  /** Latest session for the user — prefer a non-ENDED one, else the latest ever. */
  private async findLatestSession(userId: string): Promise<TradingSession | null> {
    const nonEnded = await this.sessionRepo.findOne({
      where: { userId, status: Not(TradingSessionStatus.ENDED) },
      order: { createdAt: 'DESC' },
    });
    if (nonEnded) return nonEnded;
    return this.sessionRepo.findOne({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  private async loadExecutionHealth(
    userId: string,
    now: Date,
  ): Promise<LiveExecutionHealthSummaryDto> {
    const cutoff = new Date(now.getTime() - LIVE_ACCOUNT_TERMINAL_WINDOW_MS);
    const [
      openPositions,
      workingOrders,
      pendingOrders,
      pendingTrades,
      rejectedLast24h,
      filledLast24h,
    ] = await Promise.all([
      this.tradeRepo.count({ where: { userId, status: TradeStatus.OPEN } }),
      this.orderRepo.count({ where: { userId, status: In([...ORDER_WORKING_STATUSES]) } }),
      this.orderRepo.count({ where: { userId, status: OrderStatus.RECONCILIATION_PENDING } }),
      this.tradeRepo.count({ where: { userId, status: TradeStatus.RECONCILIATION_PENDING } }),
      this.orderRepo.count({
        where: { userId, status: OrderStatus.REJECTED, createdAt: MoreThanOrEqual(cutoff) },
      }),
      this.orderRepo.count({
        where: { userId, status: OrderStatus.FILLED, createdAt: MoreThanOrEqual(cutoff) },
      }),
    ]);

    return {
      openPositions,
      workingOrders,
      reconciliationPending: pendingOrders + pendingTrades,
      rejectedLast24h,
      filledLast24h,
    };
  }

  private groupOpenDiscrepancies(
    openDiscrepancies: ReconciliationDiscrepancy[],
  ): Map<string, OpenDiscrepancyCounts> {
    const grouped = new Map<string, OpenDiscrepancyCounts>();
    for (const discrepancy of openDiscrepancies) {
      const counts = grouped.get(discrepancy.brokerConnectionId) ?? {
        total: 0,
        critical: 0,
        warning: 0,
      };
      counts.total += 1;
      if (discrepancy.severity === ReconciliationDiscrepancySeverity.CRITICAL) counts.critical += 1;
      if (discrepancy.severity === ReconciliationDiscrepancySeverity.WARNING) counts.warning += 1;
      grouped.set(discrepancy.brokerConnectionId, counts);
    }
    return grouped;
  }

  // ─── View mappers ──────────────────────────────────────────────────────────

  private toConnectionView(
    connection: BrokerConnection,
    account: BrokerAccount | undefined,
    lastRun: ReconciliationRun | null,
    openCounts: OpenDiscrepancyCounts | undefined,
    now: Date,
  ): LiveAccountConnectionViewDto {
    const financial: LiveAccountFinancialSummaryDto | null = account
      ? {
          currency: account.currency ?? null,
          balance: account.balance,
          equity: account.equity,
          margin: account.margin,
          freeMargin: account.freeMargin,
          marginLevel: account.marginLevel ?? null,
          openPositionsCount: account.openPositionsCount,
          syncedAt: toIsoString(account.syncedAt),
        }
      : null;

    const openCritical = openCounts?.critical ?? 0;
    const openWarning = openCounts?.warning ?? 0;

    const reconciliation: LiveReconciliationSummaryDto = {
      lastRunAt: toIsoString(lastRun?.startedAt ?? null),
      lastRunStatus: lastRun?.status ?? null,
      openDiscrepancies: openCounts?.total ?? 0,
      openCritical,
      openWarning,
      inSync: openCritical + openWarning === 0,
    };

    return {
      id: connection.id,
      brokerName: connection.brokerName,
      displayName: connection.displayName ?? null,
      maskedAccountId: maskAccountId(connection.accountId),
      accountType: connection.accountType,
      accountCurrency: connection.accountCurrency ?? null,
      accountLeverage: connection.accountLeverage ?? null,
      connectionStatus: connection.status,
      authorizationStatus: connection.authorizationStatus,
      credentialStatus: connection.credentialStatus,
      executable: this.isExecutable(connection),
      liveTradingEnabled: connection.liveTradingEnabled === true,
      health: this.deriveConnectionHealth(connection, financial, now),
      lastSyncAt: toIsoString(connection.lastSyncAt),
      lastHealthCheckAt: toIsoString(connection.lastHealthCheckAt),
      lastErrorMessage: sanitizeErrorMessage(connection.lastErrorMessage),
      financial,
      reconciliation,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }

  /**
   * REUSED Sprint 50 fail-closed gate (Directive §14/§48) — delegated to
   * BrokerService.isConnectionExecutable. Never re-implemented here; a
   * throwing gate is treated as NOT executable.
   */
  private isExecutable(connection: BrokerConnection): boolean {
    try {
      return this.brokerService.isConnectionExecutable(connection) === true;
    } catch {
      return false;
    }
  }

  /**
   * Server-derived health roll-up. Fail-closed: the default is UNKNOWN, and
   * any derivation error also collapses to UNKNOWN.
   *
   *   UNHEALTHY — authorization ERROR/REVOKED/SUSPENDED, or connection ERROR
   *   DEGRADED  — credentials EXPIRED/INVALID/ROTATED(pending), financial
   *               synced > 24h ago, or a non-error connection carrying an
   *               error message
   *   HEALTHY   — CONNECTED + authorization ACTIVE/AUTHORIZED + credentials
   *               VERIFIED
   *   UNKNOWN   — everything else (fail-closed default)
   */
  private deriveConnectionHealth(
    connection: BrokerConnection,
    financial: LiveAccountFinancialSummaryDto | null,
    now: Date,
  ): LiveConnectionHealth {
    try {
      const unhealthyAuthorization =
        connection.authorizationStatus === BrokerAuthorizationStatus.ERROR ||
        connection.authorizationStatus === BrokerAuthorizationStatus.REVOKED ||
        connection.authorizationStatus === BrokerAuthorizationStatus.SUSPENDED;
      if (unhealthyAuthorization || connection.status === BrokerConnectionStatus.ERROR) {
        return LiveConnectionHealth.UNHEALTHY;
      }

      const degradedCredentials =
        connection.credentialStatus === BrokerCredentialStatus.EXPIRED ||
        connection.credentialStatus === BrokerCredentialStatus.INVALID ||
        connection.credentialStatus === BrokerCredentialStatus.ROTATED;

      const financialStale =
        financial?.syncedAt !== null &&
        financial?.syncedAt !== undefined &&
        now.getTime() - new Date(financial.syncedAt).getTime() > LIVE_ACCOUNT_FINANCIAL_STALE_MS;

      const carriesErrorMessage = connection.lastErrorMessage != null;

      if (degradedCredentials || financialStale || carriesErrorMessage) {
        return LiveConnectionHealth.DEGRADED;
      }

      const healthy =
        connection.status === BrokerConnectionStatus.CONNECTED &&
        (connection.authorizationStatus === BrokerAuthorizationStatus.ACTIVE ||
          connection.authorizationStatus === BrokerAuthorizationStatus.AUTHORIZED) &&
        connection.credentialStatus === BrokerCredentialStatus.VERIFIED;
      if (healthy) {
        return LiveConnectionHealth.HEALTHY;
      }

      return LiveConnectionHealth.UNKNOWN;
    } catch {
      return LiveConnectionHealth.UNKNOWN;
    }
  }

  private toAutomationSummary(
    session: TradingSession | null,
    riskProfile: RiskProfile | null,
  ): LiveAutomationSummaryDto {
    const killSwitchActive = riskProfile?.killSwitchActive === true;
    const killSwitchReason = riskProfile?.killSwitchReason ?? null;

    if (!session) {
      return {
        status: LiveAutomationStatus.IDLE,
        sessionId: null,
        sessionConnectionId: null,
        killSwitchActive,
        killSwitchReason,
        startedAt: null,
        endedAt: null,
      };
    }

    return {
      status: this.mapAutomationStatus(session.status),
      sessionId: session.id,
      sessionConnectionId: session.brokerConnectionId,
      killSwitchActive,
      killSwitchReason,
      startedAt: toIsoString(session.startedAt),
      endedAt: toIsoString(session.endedAt),
    };
  }

  private mapAutomationStatus(status: TradingSessionStatus): LiveAutomationStatus {
    switch (status) {
      case TradingSessionStatus.ACTIVE:
        return LiveAutomationStatus.ACTIVE;
      case TradingSessionStatus.PAUSED:
        return LiveAutomationStatus.PAUSED;
      case TradingSessionStatus.SUSPENDED_RISK_LIMIT:
        return LiveAutomationStatus.SUSPENDED_RISK_LIMIT;
      case TradingSessionStatus.SUSPENDED_BROKER:
        return LiveAutomationStatus.SUSPENDED_BROKER;
      case TradingSessionStatus.ENDED:
        return LiveAutomationStatus.ENDED;
      default:
        return LiveAutomationStatus.IDLE;
    }
  }

  /**
   * Directive §36 worst-case banner. Presentation precedence is
   * LIVE > DEMO > PAPER > UNKNOWN, but environment PROVENANCE is fail-closed:
   * - no connections at all → UNKNOWN (no connection = no environment truth);
   * - PAPER only when some connection is explicitly PAPER mode ('PAPER' is
   *   defensive — `BrokerMode` currently defines DEMO/LIVE only);
   * - connections whose mode cannot be proven are never downgraded to PAPER —
   *   they roll up to UNKNOWN instead.
   */
  private deriveEnvironment(connections: BrokerConnection[]): LiveAccountEnvironment {
    if (connections.length === 0) {
      return LiveAccountEnvironment.UNKNOWN;
    }
    if (connections.some((connection) => connection.accountType === BrokerMode.LIVE)) {
      return LiveAccountEnvironment.LIVE;
    }
    if (connections.some((connection) => connection.accountType === BrokerMode.DEMO)) {
      return LiveAccountEnvironment.DEMO;
    }
    if (connections.some((connection) => (connection.accountType as string) === 'PAPER')) {
      return LiveAccountEnvironment.PAPER;
    }
    return LiveAccountEnvironment.UNKNOWN;
  }

  // ─── Alert derivation (server-side, Directive §38) ─────────────────────────

  private deriveAlerts(
    connections: BrokerConnection[],
    connectionViews: LiveAccountConnectionViewDto[],
    automation: LiveAutomationSummaryDto,
    now: Date,
  ): LiveAccountAlertViewDto[] {
    const alerts: LiveAccountAlertViewDto[] = [];
    const viewByConnection = new Map(connectionViews.map((view) => [view.id, view]));

    for (const connection of connections) {
      const brokerName = connection.brokerName;
      const key = (kind: LiveAccountAlertKind) => `${kind}:${connection.id}`;

      if (connection.authorizationStatus === BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED) {
        alerts.push({
          kind: LiveAccountAlertKind.AUTHORIZATION_REQUIRED,
          severity: LiveAccountAlertSeverity.WARNING,
          key: key(LiveAccountAlertKind.AUTHORIZATION_REQUIRED),
          connectionId: connection.id,
          brokerName,
          message: `${brokerName} requires explicit authorization before automation can execute.`,
          action: 'Re-authorize this broker connection in Settings → Broker Accounts',
        });
      }

      if (connection.credentialStatus === BrokerCredentialStatus.INVALID) {
        alerts.push({
          kind: LiveAccountAlertKind.CREDENTIALS_INVALID,
          severity: LiveAccountAlertSeverity.CRITICAL,
          key: key(LiveAccountAlertKind.CREDENTIALS_INVALID),
          connectionId: connection.id,
          brokerName,
          message: `${brokerName} credentials were rejected by the provider.`,
          action: 'Rotate your broker credentials',
        });
      } else if (connection.credentialStatus === BrokerCredentialStatus.EXPIRED) {
        alerts.push({
          kind: LiveAccountAlertKind.CREDENTIALS_EXPIRED,
          severity: LiveAccountAlertSeverity.WARNING,
          key: key(LiveAccountAlertKind.CREDENTIALS_EXPIRED),
          connectionId: connection.id,
          brokerName,
          message: `${brokerName} credentials have expired.`,
          action: 'Rotate your broker credentials',
        });
      }

      if (
        connection.status === BrokerConnectionStatus.ERROR ||
        connection.lastErrorMessage != null
      ) {
        alerts.push({
          kind: LiveAccountAlertKind.CONNECTION_ERROR,
          severity: LiveAccountAlertSeverity.CRITICAL,
          key: key(LiveAccountAlertKind.CONNECTION_ERROR),
          connectionId: connection.id,
          brokerName,
          message: `${brokerName} connection reported an error.`,
          action: 'Reconnect or verify credentials',
        });
      }

      const view = viewByConnection.get(connection.id);
      if (view) {
        if (view.reconciliation.openCritical > 0) {
          alerts.push({
            kind: LiveAccountAlertKind.RECONCILIATION_DISCREPANCIES,
            severity: LiveAccountAlertSeverity.CRITICAL,
            key: key(LiveAccountAlertKind.RECONCILIATION_DISCREPANCIES),
            connectionId: connection.id,
            brokerName,
            message: `${brokerName}: ${view.reconciliation.openDiscrepancies} open reconciliation discrepancies (${view.reconciliation.openCritical} critical)`,
            action: 'Review reconciliation state',
          });
        } else if (view.reconciliation.openWarning > 0) {
          alerts.push({
            kind: LiveAccountAlertKind.RECONCILIATION_DISCREPANCIES,
            severity: LiveAccountAlertSeverity.WARNING,
            key: key(LiveAccountAlertKind.RECONCILIATION_DISCREPANCIES),
            connectionId: connection.id,
            brokerName,
            message: `${brokerName}: ${view.reconciliation.openDiscrepancies} open reconciliation discrepancies (${view.reconciliation.openCritical} critical)`,
            action: 'Review reconciliation state',
          });
        }

        const syncedAtMs =
          view.financial?.syncedAt != null ? new Date(view.financial.syncedAt).getTime() : null;
        const financialStaleOrMissing =
          view.financial == null ||
          syncedAtMs == null ||
          now.getTime() - syncedAtMs > LIVE_ACCOUNT_SYNC_STALE_ALERT_MS;
        if (connection.status === BrokerConnectionStatus.CONNECTED && financialStaleOrMissing) {
          alerts.push({
            kind: LiveAccountAlertKind.ACCOUNT_SYNC_STALE,
            severity: LiveAccountAlertSeverity.WARNING,
            key: key(LiveAccountAlertKind.ACCOUNT_SYNC_STALE),
            connectionId: connection.id,
            brokerName,
            message: `${brokerName} account snapshot is missing or stale.`,
            action: 'Wait for the next account sync or reconnect',
          });
        }
      }
    }

    if (automation.killSwitchActive) {
      alerts.push({
        kind: LiveAccountAlertKind.KILL_SWITCH_ACTIVE,
        severity: LiveAccountAlertSeverity.CRITICAL,
        key: `${LiveAccountAlertKind.KILL_SWITCH_ACTIVE}:account`,
        connectionId: null,
        brokerName: null,
        message: automation.killSwitchReason
          ? `Kill switch is active: ${automation.killSwitchReason}`
          : 'Kill switch is active.',
        action: 'Review risk limits before re-enabling automation',
      });
    }

    if (
      automation.status === LiveAutomationStatus.SUSPENDED_RISK_LIMIT ||
      automation.status === LiveAutomationStatus.SUSPENDED_BROKER
    ) {
      alerts.push({
        kind: LiveAccountAlertKind.AUTOMATION_SUSPENDED,
        severity: LiveAccountAlertSeverity.WARNING,
        key: `${LiveAccountAlertKind.AUTOMATION_SUSPENDED}:account`,
        connectionId: null,
        brokerName: null,
        message: `Automation is suspended (${automation.status.toLowerCase().replace(/_/g, ' ')}).`,
        action: 'Resolve the suspension cause, then restart the trading session',
      });
    }

    return alerts.sort((a, b) => {
      const severityDelta = ALERT_SEVERITY_RANK[a.severity] - ALERT_SEVERITY_RANK[b.severity];
      if (severityDelta !== 0) return severityDelta;
      return a.kind.localeCompare(b.kind);
    });
  }
}
