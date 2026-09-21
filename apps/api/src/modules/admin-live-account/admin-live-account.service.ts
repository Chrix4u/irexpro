import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, MoreThanOrEqual, Repository } from 'typeorm';
import { BrokerAccount } from '../broker/entities/broker-account.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { BrokerAccountSnapshot } from '../broker/entities/broker-account-snapshot.entity';
import { BrokerService } from '../broker/broker.service';
import { BrokerAuthorizationStatus } from '../broker/authorization/broker-authorization-status';
import {
  AdapterMetadata,
  BrokerConnectionStatus,
  BrokerMode,
} from '../broker/interfaces/broker-adapter.interface';
import { BrokerAdapterRegistry } from '../broker/adapters/broker-adapter.registry';
import { BrokerProviderRegistryService } from '../broker/registry/broker-provider-registry.service';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';
import { Order } from '../execution/orders/order.entity';
import { OrderStatus } from '../execution/orders/order.enums';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import { RiskViolation } from '../risk/entities/risk-violation.entity';
import { AuditAction } from '../../common/enums/audit-action.enum';
import {
  ExecutionControlScope,
  ExecutionControlStatus,
} from '../execution-control/entities/execution-control.entity';
import {
  ExecutionControlService,
  ExecutionControlView,
} from '../execution-control/execution-control.service';
import { ReconciliationRun } from '../execution/reconciliation/entities/reconciliation-run.entity';
import { ReconciliationDiscrepancy } from '../execution/reconciliation/entities/reconciliation-discrepancy.entity';
import {
  ReconciliationDiscrepancySeverity,
  ReconciliationDiscrepancyStatus,
} from '../execution/reconciliation/reconciliation.enums';
import { AuditLog, AuditSeverity } from '../audit/entities/audit-log.entity';
import {
  AdminAuditLogFilter,
  AdminConnectionFilter,
  AdminDiscrepancyFilter,
} from './dto/admin-live-account.enums';
import {
  AdminCanaryBoundDto,
  AdminDiscrepancyCountsDto,
  AdminDispatchOutcomesDto,
  AdminEmergencyFlattenStatusDto,
  AdminExecutionControlViewDto,
  AdminExpiredControlsViewDto,
  AdminKillSwitchStateDto,
  AdminLiveOpsOverviewViewDto,
  AdminProviderRegistryEntryDto,
  AdminConnectionStateCountsDto,
  AdminStaleSnapshotAlertDto,
} from './dto/admin-live-account-overview-response.dto';
import {
  AdminConnectionsPageDto,
  toAdminConnectionRowView,
} from './dto/admin-connections-response.dto';
import {
  AdminDiscrepanciesPageDto,
  deriveDiscrepancyDescription,
  toAdminDiscrepancyRowView,
} from './dto/admin-discrepancies-response.dto';
import { AdminAuditPageDto, toAdminAuditRowView } from './dto/admin-audit-response.dto';

// ─── Public constants (Directive-tuned thresholds) ──────────────────────────

/** Default page size for admin listings. */
export const ADMIN_LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT = 50;
/** Maximum page size for admin listings. */
export const ADMIN_LIVE_ACCOUNT_MAX_PAGE_LIMIT = 100;
/** resolvedLast24h window on ReconciliationDiscrepancy.resolvedAt. */
export const ADMIN_RESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Sanitized lastErrorMessage never exceeds this length. */
export const ADMIN_ERROR_MESSAGE_MAX_LENGTH = 200;
/** Sanitized discrepancy description never exceeds this length. */
export const ADMIN_DESCRIPTION_MAX_LENGTH = 300;
/** Sanitized control reason never exceeds this length (entity column max). */
export const ADMIN_CONTROL_REASON_MAX_LENGTH = 500;
/** Max expired-control rows returned in the overview (most recent first). */
export const ADMIN_EXPIRED_CONTROLS_MAX_ROWS = 50;
/** BrokerId fallback for orphaned discrepancies (connection row gone). */
export const ADMIN_UNKNOWN_BROKER_ID = 'unknown';
/** Audit investigation actorUserId filter is truncated to this bound (uuid-like length + margin). */
export const ADMIN_AUDIT_ACTOR_FILTER_MAX_LENGTH = 64;
/** Audit investigation resourceType filter is truncated to this bound (resource names stay readable). */
export const ADMIN_AUDIT_RESOURCE_FILTER_MAX_LENGTH = 100;

/**
 * Phase 10 canary operations — ADMIN staleness-alert threshold for accepted
 * account snapshots (120s). Deliberately LOOSER than the pre-trade
 * NEW_EXPOSURE_SNAPSHOT_MAX_AGE_MS gate (30s, BrokerAccountSnapshotService):
 * this is observability, not enforcement — the enforcement gate stays where
 * it is and is never re-implemented here.
 */
export const ADMIN_STALE_SNAPSHOT_THRESHOLD_MS = 120_000;

/**
 * Phase 10 canary operations — bounded audit tail scanned for the most
 * recent emergency-flatten summary row (RISK_KILL_SWITCH_ACTIVATED with
 * metadata.emergencyFlatten = true; risk-service activations without the
 * flatten metadata are skipped).
 */
export const ADMIN_EMERGENCY_FLATTEN_AUDIT_SCAN_ROWS = 50;

/**
 * Phase 10 canary operations — certifiable providers and the env key that
 * carries the operator's certification canary exposure cap. Mirrors the
 * operator CLI contract (apps/api/scripts/run-live-certification.ts): the
 * cTrader family aliases share the family cap env; paper-broker is
 * DEMO-only and refused by the CLI, so it is NOT certifiable.
 */
export const ADMIN_CERTIFICATION_CANARY_EXPOSURE_ENV_KEYS: readonly {
  brokerId: string;
  envKey: string;
}[] = [
  { brokerId: 'metatrader5', envKey: 'METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE' },
  { brokerId: 'oanda', envKey: 'OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE' },
  { brokerId: 'ctrader', envKey: 'CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE' },
  { brokerId: 'pepperstone-ctrader', envKey: 'CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE' },
  { brokerId: 'icmarkets-ctrader', envKey: 'CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE' },
];

/** Alphanumeric runs of 16+ chars are treated as key/token material (Directive §40). */
const SECRET_LIKE_RUN = /[A-Za-z0-9]{16,}/g;

/** Authorization states counted as "authorized" (grant past, not revoked). */
const AUTHORIZED_AUTHORIZATION_STATUSES: readonly BrokerAuthorizationStatus[] = [
  BrokerAuthorizationStatus.AUTHORIZED,
  BrokerAuthorizationStatus.READY,
  BrokerAuthorizationStatus.ACTIVE,
];

// ─── Pure helpers (exported for reuse by the controllers + tests) ───────────

export function clampPaginationLimit(limit: number): number {
  const truncated = Math.trunc(
    Number.isFinite(limit) ? limit : ADMIN_LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT,
  );
  return Math.min(Math.max(truncated, 1), ADMIN_LIVE_ACCOUNT_MAX_PAGE_LIMIT);
}

export function clampPaginationOffset(offset: number): number {
  const truncated = Math.trunc(Number.isFinite(offset) ? offset : 0);
  return Math.max(truncated, 0);
}

/** Only exact enum values pass; anything else safely falls back to ALL. */
export function normalizeAdminConnectionFilter(
  filter: AdminConnectionFilter | string | null | undefined,
): AdminConnectionFilter {
  if (
    filter === AdminConnectionFilter.CONNECTED ||
    filter === AdminConnectionFilter.ERROR ||
    filter === AdminConnectionFilter.LIVE ||
    filter === AdminConnectionFilter.DEMO
  ) {
    return filter;
  }
  return AdminConnectionFilter.ALL;
}

export function normalizeAdminDiscrepancyFilter(
  filter: AdminDiscrepancyFilter | string | null | undefined,
): AdminDiscrepancyFilter {
  if (
    filter === AdminDiscrepancyFilter.OPEN ||
    filter === AdminDiscrepancyFilter.RESOLVED ||
    filter === AdminDiscrepancyFilter.CRITICAL ||
    filter === AdminDiscrepancyFilter.WARNING
  ) {
    return filter;
  }
  return AdminDiscrepancyFilter.ALL;
}

export function normalizeAdminAuditFilter(
  filter: AdminAuditLogFilter | string | null | undefined,
): AdminAuditLogFilter {
  if (filter === AdminAuditLogFilter.CRITICAL || filter === AdminAuditLogFilter.WARNING) {
    return filter;
  }
  return AdminAuditLogFilter.ALL;
}

/**
 * Scrub a free-text field for admin display: replace secret-like alphanumeric
 * runs with "…", then cap the length. Returns null for empty results.
 */
export function sanitizeAdminText(
  message: string | null | undefined,
  maxLength: number,
): string | null {
  if (!message) return null;
  const scrubbed = message.replace(SECRET_LIKE_RUN, '…');
  const trimmed = scrubbed.length > maxLength ? scrubbed.slice(0, maxLength) : scrubbed;
  return trimmed.trim().length > 0 ? trimmed : null;
}

/** Masked display for a scoped control target (last 4, "•••" prefix). */
export function maskControlScopeTarget(scopeKey: string | null): string | null {
  if (!scopeKey || scopeKey.length < 4) return null;
  return `•••${scopeKey.slice(-4)}`;
}

/**
 * Trim + truncate a client-supplied audit investigation filter so over-long
 * values can never bloat queries or logs. Returns '' when the value is not a
 * usable string (the caller then omits the filter entirely).
 */
export function boundAdminAuditFilter(value: string | null | undefined, maxLength: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * AdminLiveAccountService — read-only ADMIN visibility over the live-account
 * architecture (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * ADMIN SCOPE: cross-user visibility is intentional (RBAC enforced at the
 * controllers). No client-supplied userId is ever accepted as an input —
 * audit-investigation filters (actorUserId / resourceType) are used ONLY as
 * equality filters and never for anything broader.
 *
 * SECURITY (read-only projection by construction): credential material
 * (encryptedCredentials, credentialIv, credentialTag, encryptionKeyId),
 * provider secrets, audit metadata blobs, IP addresses, and user agents never
 * enter any DTO. Account identifiers are masked to the last 4 characters.
 * `lastErrorMessage`, discrepancy descriptions, and control reasons are
 * sanitized (secret-like runs stripped) + truncated. The Sprint 50
 * fail-closed executable gate is REUSED via
 * BrokerService.isConnectionExecutable (never re-implemented).
 *
 * NO new tables — this module only aggregates existing PR-1..PR-5 state.
 */
@Injectable()
export class AdminLiveAccountService {
  constructor(
    @InjectRepository(BrokerConnection)
    private readonly connectionRepo: Repository<BrokerConnection>,
    @InjectRepository(BrokerAccount)
    private readonly accountRepo: Repository<BrokerAccount>,
    @InjectRepository(TradingSession)
    private readonly sessionRepo: Repository<TradingSession>,
    @InjectRepository(ReconciliationRun)
    private readonly runRepo: Repository<ReconciliationRun>,
    @InjectRepository(ReconciliationDiscrepancy)
    private readonly discrepancyRepo: Repository<ReconciliationDiscrepancy>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(RiskProfile)
    private readonly riskProfileRepo: Repository<RiskProfile>,
    @InjectRepository(RiskViolation)
    private readonly riskViolationRepo: Repository<RiskViolation>,
    @InjectRepository(BrokerAccountSnapshot)
    private readonly snapshotRepo: Repository<BrokerAccountSnapshot>,
    private readonly executionControlService: ExecutionControlService,
    private readonly providerRegistry: BrokerProviderRegistryService,
    private readonly brokerService: BrokerService,
    private readonly adapterRegistry: BrokerAdapterRegistry,
    private readonly configService: ConfigService,
  ) {}

  // ─── GET /admin/live-account/overview ─────────────────────────────────────

  async getOverview(now: Date = new Date()): Promise<AdminLiveOpsOverviewViewDto> {
    const cutoff = new Date(now.getTime() - ADMIN_RESOLVED_WINDOW_MS);

    const [
      connections,
      openDiscrepancies,
      resolvedLast24h,
      activeControls,
      expiredControls,
      activeSessions,
      suspendedSessions,
      // Phase 10 canary-operations blocks — each failure-tolerant (a failing
      // optional panel degrades to null, never fails the whole overview).
      adapterVersions,
      dispatchOutcomes,
      emergencyFlattenStatus,
      killSwitchState,
      canaryBounds,
    ] = await Promise.all([
      this.connectionRepo.find(),
      this.discrepancyRepo.find({
        where: { status: ReconciliationDiscrepancyStatus.OPEN },
      }),
      this.discrepancyRepo.count({
        where: {
          status: ReconciliationDiscrepancyStatus.RESOLVED,
          resolvedAt: MoreThanOrEqual(cutoff),
        },
      }),
      this.loadActiveControls(),
      this.loadExpiredControls(),
      this.sessionRepo.count({ where: { status: TradingSessionStatus.ACTIVE } }),
      this.sessionRepo.count({
        where: {
          status: In([
            TradingSessionStatus.SUSPENDED_RISK_LIMIT,
            TradingSessionStatus.SUSPENDED_BROKER,
          ]),
        },
      }),
      this.loadAdapterVersions(),
      this.loadDispatchOutcomes(cutoff),
      this.loadEmergencyFlattenStatus(),
      this.loadKillSwitchState(),
      this.loadCanaryBounds(),
    ]);

    // Stale-snapshot alerts derive from the JUST-LOADED connection inventory
    // (no second connection query) — therefore sequenced after the load.
    const staleSnapshotAlerts = await this.loadStaleSnapshotAlerts(connections, now);

    const severityCounts = new Map<ReconciliationDiscrepancySeverity, number>();
    for (const discrepancy of openDiscrepancies) {
      severityCounts.set(discrepancy.severity, (severityCounts.get(discrepancy.severity) ?? 0) + 1);
    }

    const discrepancies: AdminDiscrepancyCountsDto = {
      open: openDiscrepancies.length,
      openCritical: severityCounts.get(ReconciliationDiscrepancySeverity.CRITICAL) ?? 0,
      openWarning: severityCounts.get(ReconciliationDiscrepancySeverity.WARNING) ?? 0,
      openInfo: severityCounts.get(ReconciliationDiscrepancySeverity.INFO) ?? 0,
      resolvedLast24h,
    };

    return {
      generatedAt: now.toISOString(),
      connections: this.countConnectionStates(connections),
      discrepancies,
      activeControls,
      expiredControls,
      providers: this.mapProviders(),
      automation: {
        activeSessions,
        suspendedSessions,
      },
      adapterVersions,
      dispatchOutcomes,
      staleSnapshotAlerts,
      emergencyFlattenStatus,
      killSwitchState,
      canaryBounds,
    };
  }

  // ─── GET /admin/live-account/connections ──────────────────────────────────

  async getConnections(
    filter: AdminConnectionFilter | string | null | undefined = AdminConnectionFilter.ALL,
    limit: number = ADMIN_LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT,
    offset: number = 0,
  ): Promise<AdminConnectionsPageDto> {
    const safeFilter = normalizeAdminConnectionFilter(filter);
    const safeLimit = clampPaginationLimit(limit);
    const safeOffset = clampPaginationOffset(offset);

    const where: FindOptionsWhere<BrokerConnection> | undefined =
      safeFilter === AdminConnectionFilter.CONNECTED
        ? { status: BrokerConnectionStatus.CONNECTED }
        : safeFilter === AdminConnectionFilter.ERROR
          ? { status: BrokerConnectionStatus.ERROR }
          : safeFilter === AdminConnectionFilter.LIVE
            ? { accountType: BrokerMode.LIVE }
            : safeFilter === AdminConnectionFilter.DEMO
              ? { accountType: BrokerMode.DEMO }
              : undefined;

    const [connections, total, openDiscrepancyCounts] = await Promise.all([
      this.connectionRepo.find({
        ...(where ? { where } : {}),
        order: { createdAt: 'DESC' },
        take: safeLimit,
        skip: safeOffset,
      }),
      this.connectionRepo.count(where ? { where } : {}),
      this.countOpenDiscrepanciesByConnection(),
    ]);

    return {
      connections: connections.map((connection) =>
        toAdminConnectionRowView(
          connection,
          this.isExecutable(connection),
          sanitizeAdminText(connection.lastErrorMessage, ADMIN_ERROR_MESSAGE_MAX_LENGTH),
          openDiscrepancyCounts.get(connection.id) ?? 0,
        ),
      ),
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  // ─── GET /admin/live-account/reconciliation/discrepancies ─────────────────

  async getDiscrepancies(
    filter: AdminDiscrepancyFilter | string | null | undefined = AdminDiscrepancyFilter.ALL,
    limit: number = ADMIN_LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT,
    offset: number = 0,
  ): Promise<AdminDiscrepanciesPageDto> {
    const safeFilter = normalizeAdminDiscrepancyFilter(filter);
    const safeLimit = clampPaginationLimit(limit);
    const safeOffset = clampPaginationOffset(offset);

    // Severity filters imply OPEN rows of that severity.
    const where: FindOptionsWhere<ReconciliationDiscrepancy> | undefined =
      safeFilter === AdminDiscrepancyFilter.OPEN
        ? { status: ReconciliationDiscrepancyStatus.OPEN }
        : safeFilter === AdminDiscrepancyFilter.RESOLVED
          ? { status: ReconciliationDiscrepancyStatus.RESOLVED }
          : safeFilter === AdminDiscrepancyFilter.CRITICAL
            ? {
                severity: ReconciliationDiscrepancySeverity.CRITICAL,
                status: ReconciliationDiscrepancyStatus.OPEN,
              }
            : safeFilter === AdminDiscrepancyFilter.WARNING
              ? {
                  severity: ReconciliationDiscrepancySeverity.WARNING,
                  status: ReconciliationDiscrepancyStatus.OPEN,
                }
              : undefined;

    const [discrepancies, total] = await Promise.all([
      this.discrepancyRepo.find({
        ...(where ? { where } : {}),
        order: { firstDetectedAt: 'DESC' },
        take: safeLimit,
        skip: safeOffset,
      }),
      this.discrepancyRepo.count(where ? { where } : {}),
    ]);

    const brokerIds = await this.loadBrokerIds(discrepancies.map((d) => d.brokerConnectionId));

    return {
      discrepancies: discrepancies.map((discrepancy) =>
        toAdminDiscrepancyRowView(
          discrepancy,
          brokerIds.get(discrepancy.brokerConnectionId) ?? ADMIN_UNKNOWN_BROKER_ID,
          sanitizeAdminText(
            deriveDiscrepancyDescription(discrepancy),
            ADMIN_DESCRIPTION_MAX_LENGTH,
          ) ?? discrepancy.type,
        ),
      ),
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  // ─── GET /admin/audit/logs ────────────────────────────────────────────────

  async getAuditLogs(
    filter: AdminAuditLogFilter | string | null | undefined = AdminAuditLogFilter.ALL,
    actorUserId: string | null | undefined = null,
    resourceType: string | null | undefined = null,
    limit: number = ADMIN_LIVE_ACCOUNT_DEFAULT_PAGE_LIMIT,
    offset: number = 0,
  ): Promise<AdminAuditPageDto> {
    const safeFilter = normalizeAdminAuditFilter(filter);
    const safeLimit = clampPaginationLimit(limit);
    const safeOffset = clampPaginationOffset(offset);

    // Investigation filters are equality-only and only applied when they are
    // non-empty strings — never trusted for anything broader. Over-long values
    // are trimmed + truncated to the declared bounds (G3) before entering the
    // where clause.
    const where: FindOptionsWhere<AuditLog> = {};
    if (safeFilter === AdminAuditLogFilter.CRITICAL) {
      where.severity = AuditSeverity.CRITICAL;
    } else if (safeFilter === AdminAuditLogFilter.WARNING) {
      where.severity = AuditSeverity.WARNING;
    }
    const actor = boundAdminAuditFilter(actorUserId, ADMIN_AUDIT_ACTOR_FILTER_MAX_LENGTH);
    if (actor.length > 0) where.actorUserId = actor;
    const resource = boundAdminAuditFilter(resourceType, ADMIN_AUDIT_RESOURCE_FILTER_MAX_LENGTH);
    if (resource.length > 0) where.resourceType = resource;

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
      logs: logs.map(toAdminAuditRowView),
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  // ─── Phase 10 canary-operations helpers (failure-tolerant) ────────────────

  /**
   * Failure-tolerance wrapper: a failing optional panel degrades to null
   * instead of failing the whole overview (same discipline as the
   * isExecutable fail-closed catch).
   */
  private async optionalPanel<T>(load: () => Promise<T> | T): Promise<T | null> {
    try {
      return await load();
    } catch {
      return null;
    }
  }

  /**
   * Adapter implementation version per brokerId, read from the metadata-only
   * ROOT adapters (BrokerAdapterRegistry — never an isolated mutable session
   * context). Adapters that carry no version annotation are reported as null;
   * registered aliases (e.g. pepperstone-ctrader) resolve to their canonical
   * provider's version. No adapter internals beyond the version string.
   */
  private async loadAdapterVersions(): Promise<Record<string, string | null> | null> {
    return this.optionalPanel(() => {
      const versions: Record<string, string | null> = {};
      for (const brokerId of this.adapterRegistry.getSupportedBrokerIds()) {
        const adapter = this.adapterRegistry.getAdapter(brokerId);
        const version = (adapter as Partial<AdapterMetadata>).adapterVersion;
        versions[brokerId] = typeof version === 'string' && version.trim() !== '' ? version : null;
      }
      return versions;
    });
  }

  /**
   * Order-dispatch outcome counts (all users — admin scope):
   * - unknownResultOpenCount: trading.orders with status RECONCILIATION_PENDING
   *   (the dispatch outcome is unknown — reconciliation owns convergence);
   * - rejectedLast24h: orders that reached terminal REJECTED with
   *   finalizedAt in the last 24h (risk engine or provider rejection);
   * - dispatchBlocksLast24h: RiskViolation rows recorded in the last 24h —
   *   every row is a pre-dispatch block (the risk engine runs before the
   *   dispatch boundary). This third count degrades ALONE to null.
   */
  private async loadDispatchOutcomes(cutoff: Date): Promise<AdminDispatchOutcomesDto | null> {
    return this.optionalPanel(async () => {
      const [unknownResultOpenCount, rejectedLast24h] = await Promise.all([
        this.orderRepo.count({ where: { status: OrderStatus.RECONCILIATION_PENDING } }),
        this.orderRepo.count({
          where: { status: OrderStatus.REJECTED, finalizedAt: MoreThanOrEqual(cutoff) },
        }),
      ]);
      const dispatchBlocksLast24h = await this.optionalPanel(() =>
        this.riskViolationRepo.count({ where: { evaluatedAt: MoreThanOrEqual(cutoff) } }),
      );
      return { unknownResultOpenCount, rejectedLast24h, dispatchBlocksLast24h };
    });
  }

  /**
   * Stale-snapshot alerts over the ALREADY-LOADED connection inventory:
   * CONNECTED connections whose latest ACCEPTED snapshot (read-only repository
   * query, ordered by generation — the same ordering discipline as
   * BrokerAccountSnapshotService.readLatestAcceptedSnapshot; that service is
   * never modified) has an observation instant (providerObservedAt ??
   * acceptedAt) older than ADMIN_STALE_SNAPSHOT_THRESHOLD_MS, plus CONNECTED
   * LIVE connections with NO accepted snapshot at all. A missing snapshot on
   * a CONNECTED DEMO connection is not alert-worthy (LIVE is the
   * exposure-authoritative case).
   */
  private async loadStaleSnapshotAlerts(
    connections: BrokerConnection[],
    now: Date,
  ): Promise<AdminStaleSnapshotAlertDto[] | null> {
    return this.optionalPanel(async () => {
      const connected = connections.filter(
        (connection) => connection.status === BrokerConnectionStatus.CONNECTED,
      );
      if (connected.length === 0) return [];

      const latestSnapshots = await Promise.all(
        connected.map((connection) =>
          this.snapshotRepo.findOne({
            where: { connectionId: connection.id },
            order: { generation: 'DESC' },
            select: ['connectionId', 'generation', 'acceptedAt', 'providerObservedAt'],
          }),
        ),
      );

      const alerts: AdminStaleSnapshotAlertDto[] = [];
      for (let index = 0; index < connected.length; index += 1) {
        const connection = connected[index];
        const snapshot = latestSnapshots[index];

        if (!snapshot) {
          if (connection.accountType === BrokerMode.LIVE) {
            alerts.push({
              connectionId: connection.id,
              brokerId: connection.brokerId,
              accountType: connection.accountType,
              lastAcceptedAt: null,
              ageSeconds: null,
            });
          }
          continue;
        }

        // Observation instant (provider time where reported, else server
        // accept time) — the same freshness semantics as the pre-trade gate.
        const observedAt = snapshot.providerObservedAt ?? snapshot.acceptedAt ?? null;
        if (!observedAt) continue; // malformed row — never fabricate staleness

        const ageMs = now.getTime() - observedAt.getTime();
        if (ageMs > ADMIN_STALE_SNAPSHOT_THRESHOLD_MS) {
          alerts.push({
            connectionId: connection.id,
            brokerId: connection.brokerId,
            accountType: connection.accountType,
            lastAcceptedAt: snapshot.acceptedAt ? snapshot.acceptedAt.toISOString() : null,
            ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
          });
        }
      }
      return alerts;
    });
  }

  /**
   * Most recent emergency flatten, from the audit log tail: the newest
   * RISK_KILL_SWITCH_ACTIVATED row whose metadata carries
   * emergencyFlatten = true (the summary audit ExecutionService writes after
   * a kill-switch force-close — risk-service activation audits WITHOUT that
   * marker are skipped). Outcome derivation from the recorded counts:
   * COMPLETE (all target positions closed) / PARTIAL (some not closed — a
   * failed close and an unknown-outcome close are NOT separable in the
   * summary audit, and are never claimed to be) / UNVERIFIED (metadata
   * without usable counts). No raw audit metadata blob ever leaves this
   * method — only the derived fields + a sanitized description.
   */
  private async loadEmergencyFlattenStatus(): Promise<AdminEmergencyFlattenStatusDto | null> {
    return this.optionalPanel(async () => {
      const rows = await this.auditRepo.find({
        where: { action: AuditAction.RISK_KILL_SWITCH_ACTIVATED },
        order: { createdAt: 'DESC' },
        take: ADMIN_EMERGENCY_FLATTEN_AUDIT_SCAN_ROWS,
      });
      const latest = rows.find(
        (row) =>
          typeof row.metadata === 'object' &&
          row.metadata !== null &&
          (row.metadata as Record<string, unknown>).emergencyFlatten === true,
      );
      if (!latest) {
        return { lastRequestedAt: null, lastOutcome: null, description: null };
      }

      const metadata = latest.metadata as Record<string, unknown>;
      const targetCount = Number(metadata.targetCount);
      const closedCount = Number(metadata.closedCount);
      const countsUsable =
        Number.isFinite(targetCount) &&
        Number.isFinite(closedCount) &&
        targetCount > 0 &&
        closedCount >= 0;

      let lastOutcome: AdminEmergencyFlattenStatusDto['lastOutcome'] = 'UNVERIFIED';
      if (countsUsable) {
        lastOutcome = closedCount >= targetCount ? 'COMPLETE' : 'PARTIAL';
      }

      let description: string | null;
      if (!countsUsable) {
        description = 'Emergency flatten recorded — outcome counts unavailable in the audit record';
      } else {
        const closeReason =
          typeof metadata.closeReason === 'string' && metadata.closeReason.trim() !== ''
            ? ` (reason: ${metadata.closeReason.trim()})`
            : '';
        description =
          `Emergency flatten closed ${closedCount} of ${targetCount} open position(s)` +
          `${closeReason} — not-closed outcomes are failed or unknown-result closes`;
      }

      return {
        lastRequestedAt: latest.createdAt ? latest.createdAt.toISOString() : null,
        lastOutcome,
        description: sanitizeAdminText(description, ADMIN_DESCRIPTION_MAX_LENGTH),
      };
    });
  }

  /** Risk profiles with killSwitchActive = true (all users — admin scope). */
  private async loadKillSwitchState(): Promise<AdminKillSwitchStateDto | null> {
    return this.optionalPanel(async () => ({
      activeUsersCount: await this.riskProfileRepo.count({
        where: { killSwitchActive: true },
      }),
    }));
  }

  /**
   * Certification canary exposure caps per certifiable provider, from the
   * config service (the *_LIVE_CERT_MAX_CANARY_EXPOSURE env contract —
   * ConfigService falls back to process.env for keys not in the factory
   * configuration). Numeric exposure caps, NOT secrets: safe to expose to
   * admins. configured = false when the env var is absent (the operator CLI
   * then refuses the certification run).
   */
  private async loadCanaryBounds(): Promise<AdminCanaryBoundDto[] | null> {
    return this.optionalPanel(() =>
      ADMIN_CERTIFICATION_CANARY_EXPOSURE_ENV_KEYS.map(({ brokerId, envKey }) => {
        const raw = this.configService.get<string>(envKey);
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        const configured = trimmed !== '';
        return {
          brokerId,
          configured,
          maxCanaryExposure: configured ? trimmed : null,
        };
      }),
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Bucket all connections into the admin state-count matrix. */
  private countConnectionStates(connections: BrokerConnection[]): AdminConnectionStateCountsDto {
    const counts: AdminConnectionStateCountsDto = {
      total: connections.length,
      connected: 0,
      connecting: 0,
      error: 0,
      disconnected: 0,
      suspendedConnectionStatus: 0,
      authorized: 0,
      authorizationRequired: 0,
      revoked: 0,
      suspended: 0,
      demo: 0,
      live: 0,
    };

    for (const connection of connections) {
      if (connection.status === BrokerConnectionStatus.CONNECTED) counts.connected += 1;
      else if (connection.status === BrokerConnectionStatus.CONNECTING) counts.connecting += 1;
      else if (connection.status === BrokerConnectionStatus.ERROR) counts.error += 1;
      else if (connection.status === BrokerConnectionStatus.DISCONNECTED) counts.disconnected += 1;
      else if (connection.status === BrokerConnectionStatus.SUSPENDED)
        counts.suspendedConnectionStatus += 1;

      if (AUTHORIZED_AUTHORIZATION_STATUSES.includes(connection.authorizationStatus)) {
        counts.authorized += 1;
      } else if (
        connection.authorizationStatus === BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED
      ) {
        counts.authorizationRequired += 1;
      } else if (connection.authorizationStatus === BrokerAuthorizationStatus.REVOKED) {
        counts.revoked += 1;
      } else if (connection.authorizationStatus === BrokerAuthorizationStatus.SUSPENDED) {
        counts.suspended += 1;
      }

      if (connection.accountType === BrokerMode.DEMO) counts.demo += 1;
      else if (connection.accountType === BrokerMode.LIVE) counts.live += 1;
    }

    return counts;
  }

  /**
   * REUSED active-control inventory — delegates to
   * ExecutionControlService.listActiveControls() (ACTIVE + unexpired only:
   * the "currently blocking" inventory) and maps to the admin view
   * (normalized scope target + sanitized reason + ISO dates + status).
   */
  private async loadActiveControls(): Promise<AdminExecutionControlViewDto[]> {
    const controls: ExecutionControlView[] =
      await this.executionControlService.listActiveControls();
    return controls.map((control) => this.toAdminControlView(control));
  }

  /**
   * Expired-control inventory — delegates to
   * ExecutionControlService.listControlsIncludingExpired() and keeps only the
   * EXPIRED rows (retained records — never blocking; reactivation replaces
   * them). Payload stays bounded: the most recent
   * ADMIN_EXPIRED_CONTROLS_MAX_ROWS rows by activatedAt desc, plus the total
   * retained count.
   */
  private async loadExpiredControls(): Promise<AdminExpiredControlsViewDto> {
    const controls: ExecutionControlView[] =
      await this.executionControlService.listControlsIncludingExpired();
    const expired = controls.filter((control) => control.status === ExecutionControlStatus.EXPIRED);
    expired.sort((a, b) => b.activatedAt.getTime() - a.activatedAt.getTime());
    return {
      count: expired.length,
      controls: expired
        .slice(0, ADMIN_EXPIRED_CONTROLS_MAX_ROWS)
        .map((control) => this.toAdminControlView(control)),
    };
  }

  /** Admin view mapping for a single control view (shared by both lists). */
  private toAdminControlView(control: ExecutionControlView): AdminExecutionControlViewDto {
    return {
      id: control.id,
      scope: control.scope,
      scopeTarget: this.normalizeControlScopeTarget(control.scope, control.scopeKey),
      reason: sanitizeAdminText(control.reason, ADMIN_CONTROL_REASON_MAX_LENGTH),
      activatedBy: control.activatedByUserId ?? null,
      activatedAt: control.activatedAt.toISOString(),
      expiresAt: control.expiresAt ? control.expiresAt.toISOString() : null,
      status: control.status,
    };
  }

  /** Normalized display target: broker id / masked user or connection / null. */
  private normalizeControlScopeTarget(
    scope: ExecutionControlScope,
    scopeKey: string | null,
  ): string | null {
    if (scopeKey === null) return null;
    switch (scope) {
      case ExecutionControlScope.GLOBAL:
        return null;
      case ExecutionControlScope.PROVIDER:
        // Provider scope keys are public registry ids — displayed as-is.
        return scopeKey;
      case ExecutionControlScope.USER:
        return maskControlScopeTarget(scopeKey);
      case ExecutionControlScope.BROKER_CONNECTION:
        return maskControlScopeTarget(scopeKey);
      default:
        return maskControlScopeTarget(scopeKey);
    }
  }

  /** Registry catalog → admin provider entries (no adapter internals). */
  private mapProviders(): AdminProviderRegistryEntryDto[] {
    return this.providerRegistry.getCatalog().map((entry) => ({
      brokerId: entry.id,
      brokerName: entry.name,
      capabilities: [...entry.capabilities],
      supportsDemo: entry.environments.includes('DEMO'),
      supportsLive: entry.environments.includes('LIVE'),
      // R7-audit-D #12: production-LIVE verification evidence (always
      // materialized by the registry, default UNVERIFIED) so Admin Live Ops
      // can render verification state from the overview without a second
      // /broker/registry call. Copied — never a shared registry reference.
      // Round 7.1 (P0-3): provenance + truthful derived certification state
      // ride along so legacy attestation is never rendered as a fresh
      // protocol certification.
      productionLiveVerification: { ...entry.productionLiveVerification },
      certificationState: entry.certificationState,
    }));
  }

  /**
   * Single grouped count query over OPEN discrepancies by connectionId
   * (projection: brokerConnectionId only; counts grouped in memory).
   */
  private async countOpenDiscrepanciesByConnection(): Promise<Map<string, number>> {
    const rows = await this.discrepancyRepo.find({
      where: { status: ReconciliationDiscrepancyStatus.OPEN },
      select: ['brokerConnectionId'],
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.brokerConnectionId, (counts.get(row.brokerConnectionId) ?? 0) + 1);
    }
    return counts;
  }

  /** brokerConnectionId → brokerId enrichment (single connection query). */
  private async loadBrokerIds(brokerConnectionIds: string[]): Promise<Map<string, string>> {
    if (brokerConnectionIds.length === 0) return new Map();
    const uniqueIds = [...new Set(brokerConnectionIds)];
    const connections = await this.connectionRepo.find({
      where: { id: In(uniqueIds) },
      select: ['id', 'brokerId'],
    });
    return new Map(connections.map((connection) => [connection.id, connection.brokerId]));
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
}
