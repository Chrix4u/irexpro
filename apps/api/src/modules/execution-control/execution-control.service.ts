import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ExecutionControl,
  ExecutionControlScope,
  ExecutionControlStatus,
} from './entities/execution-control.entity';
import { ActivateExecutionControlDto } from './dto/activate-execution-control.dto';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AuditSeverity } from '../audit/entities/audit-log.entity';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';

/** Result of an execution-permission check (fail-closed). */
export interface ExecutionPermission {
  allowed: boolean;
  /** Present when blocked: the control that caused the denial. */
  blockedBy?: {
    scope: ExecutionControlScope;
    scopeKey: string | null;
    reason: string;
  };
}

/** Safe view of an active control (returned to admins). */
export interface ExecutionControlView {
  id: string;
  scope: ExecutionControlScope;
  scopeKey: string | null;
  reason: string;
  activatedByUserId: string;
  activatedAt: Date;
  expiresAt: Date | null;
}

/**
 * ExecutionControlService — server-side emergency control plane
 * (Directive §28).
 *
 * SEMANTICS
 * - A control row with status = ACTIVE and an unpassed expiry disables
 *   execution at its scope. Clearing a control deletes the row. There is no
 *   "enabled/disabled" boolean to misread.
 * - EXPIRED rows are retained as records: reads ignore them and they never
 *   block a future activation at the same (scope, scopeKey). Reactivation
 *   flips the prior ACTIVE row to status = EXPIRED and inserts a NEW ACTIVE
 *   row, so activation/expiry history is preserved per row.
 * - Checks cascade: GLOBAL > PROVIDER > USER > BROKER_CONNECTION; the first
 *   active control wins and is reported.
 * - CONCURRENCY: the partial unique index uq_exec_controls_active_scope
 *   guarantees at most one ACTIVE row per (scope, scope_key). Concurrent
 *   activations resolve to exactly one winner; the loser receives a 23505
 *   unique violation which is translated to a ConflictException — never a
 *   duplicate active control and never an unhandled 500.
 * - FAIL CLOSED (Directive §48): if the control store cannot be read, every
 *   check reports blocked with scope GLOBAL and reason
 *   'EXECUTION_CONTROL_STORE_UNAVAILABLE'. Execution is never permitted on
 *   an unreadable control plane.
 * - The control plane gates NEWLY SUBMITTED work immediately. Provider
 *   requests already in flight are resolved by the existing execution
 *   reconciliation path (uncertain-result handling) — documented in
 *   docs/brokers/execution-control-plane.md.
 */
@Injectable()
export class ExecutionControlService {
  private readonly logger = new Logger(ExecutionControlService.name);

  constructor(
    @InjectRepository(ExecutionControl)
    private readonly controlRepo: Repository<ExecutionControl>,
    private readonly auditService: AuditService,
    private readonly eventBus: DomainEventBus,
  ) {}

  // ─── Fail-closed permission checks ────────────────────────────────────────

  /**
   * Check whether execution is currently allowed for a user/connection.
   * NEVER throws — returns allowed:false on any internal failure.
   */
  async checkExecutionPermission(params: {
    userId: string;
    brokerId?: string;
    brokerConnectionId?: string;
  }): Promise<ExecutionPermission> {
    const { userId, brokerId, brokerConnectionId } = params;

    let controls: ExecutionControl[];
    try {
      controls = await this.findActiveControls();
    } catch (err) {
      // FAIL CLOSED — never permit execution when the control plane is unreadable
      this.logger.error(
        `Execution control store unavailable — failing closed: ${(err as Error).message}`,
      );
      return {
        allowed: false,
        blockedBy: {
          scope: ExecutionControlScope.GLOBAL,
          scopeKey: null,
          reason: 'EXECUTION_CONTROL_STORE_UNAVAILABLE',
        },
      };
    }

    // Cascade order: GLOBAL → PROVIDER → USER → BROKER_CONNECTION
    const global = this.matchScope(controls, ExecutionControlScope.GLOBAL, null);
    if (global) return { allowed: false, blockedBy: this.toBlock(global) };

    if (brokerId) {
      const provider = this.matchScope(controls, ExecutionControlScope.PROVIDER, brokerId);
      if (provider) return { allowed: false, blockedBy: this.toBlock(provider) };
    }

    const user = this.matchScope(controls, ExecutionControlScope.USER, userId);
    if (user) return { allowed: false, blockedBy: this.toBlock(user) };

    if (brokerConnectionId) {
      const conn = this.matchScope(
        controls,
        ExecutionControlScope.BROKER_CONNECTION,
        brokerConnectionId,
      );
      if (conn) return { allowed: false, blockedBy: this.toBlock(conn) };
    }

    return { allowed: true };
  }

  /** Throwing variant used by gatekeepers (risk pipeline, orchestrator). */
  async assertExecutionAllowed(params: {
    userId: string;
    brokerId?: string;
    brokerConnectionId?: string;
  }): Promise<void> {
    const permission = await this.checkExecutionPermission(params);
    if (!permission.allowed && permission.blockedBy) {
      throw new ForbiddenException(
        `Execution blocked by emergency control (scope=${permission.blockedBy.scope}` +
          `${permission.blockedBy.scopeKey ? `, key=${permission.blockedBy.scopeKey}` : ''}): ` +
          `${permission.blockedBy.reason}`,
      );
    }
  }

  // ─── Admin operations (RBAC enforced at controller) ──────────────────────

  /** List active (non-expired) controls. */
  async listActiveControls(): Promise<ExecutionControlView[]> {
    const controls = await this.findActiveControls();
    return controls.map((c) => ({
      id: c.id,
      scope: c.scope,
      scopeKey: c.scopeKey,
      reason: c.reason,
      activatedByUserId: c.activatedByUserId,
      activatedAt: c.activatedAt,
      expiresAt: c.expiresAt,
    }));
  }

  /**
   * Activate an emergency control at (scope, scopeKey).
   *
   * Lifecycle: only the persisted ACTIVE row can occupy the slot. Historical
   * EXPIRED rows never participate in discovery. If the ACTIVE row is expired
   * in time, retire that exact row conditionally and insert a NEW ACTIVE row.
   * If it is still effective, reject with ConflictException. Under concurrent
   * replacement the partial unique index remains the final single-winner
   * backstop; the loser's 23505 is translated to ConflictException.
   */
  async activateControl(
    dto: ActivateExecutionControlDto,
    adminUserId: string,
    ipAddress?: string,
  ): Promise<ExecutionControlView> {
    const scopeKey = this.normalizeScopeKey(dto.scope, dto.scopeKey);

    const activeControl = await this.findCurrentActiveControl(dto.scope, scopeKey);
    if (activeControl && this.isEffectivelyActive(activeControl)) {
      throw new ConflictException(
        `Execution control already active for scope=${dto.scope}` +
          `${scopeKey ? ` key=${scopeKey}` : ''}`,
      );
    }

    if (activeControl) {
      await this.retireExpiredActiveControl(activeControl);
    }

    let control: ExecutionControl;
    try {
      control = await this.controlRepo.save(
        this.controlRepo.create({
          scope: dto.scope,
          scopeKey,
          reason: dto.reason,
          activatedByUserId: adminUserId,
          activatedAt: new Date(),
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          status: ExecutionControlStatus.ACTIVE,
        }),
      );
    } catch (err) {
      // 23505 = unique_violation on uq_exec_controls_active_scope: a
      // concurrent activation won the slot. Deterministic single winner.
      // TypeORM wraps the driver error (code may sit on driverError).
      const pgCode =
        (err as { code?: string }).code ??
        (err as { driverError?: { code?: string } }).driverError?.code;
      if (pgCode === '23505') {
        throw new ConflictException(
          `Execution control already active for scope=${dto.scope}` +
            `${scopeKey ? ` key=${scopeKey}` : ''} (concurrent activation)`,
        );
      }
      throw err;
    }

    await this.auditService.log({
      actorUserId: adminUserId,
      action: AuditAction.EXECUTION_CONTROL_ACTIVATED,
      resourceType: 'ExecutionControl',
      resourceId: control.id,
      ipAddress,
      metadata: {
        scope: dto.scope,
        scopeKey,
        reason: dto.reason,
        expiresAt: dto.expiresAt ?? null,
      },
      severity: AuditSeverity.CRITICAL,
    });

    this.publishControlEvent(adminUserId, control, 'activated');

    return this.toView(control);
  }

  /** Deactivate (clear) an emergency control by id. */
  async deactivateControl(
    controlId: string,
    adminUserId: string,
    ipAddress?: string,
  ): Promise<void> {
    const control = await this.controlRepo.findOne({ where: { id: controlId } });
    if (!control) {
      throw new NotFoundException(`Execution control ${controlId} not found`);
    }

    await this.controlRepo.delete(controlId);

    await this.auditService.log({
      actorUserId: adminUserId,
      action: AuditAction.EXECUTION_CONTROL_DEACTIVATED,
      resourceType: 'ExecutionControl',
      resourceId: controlId,
      ipAddress,
      metadata: {
        scope: control.scope,
        scopeKey: control.scopeKey,
        reason: control.reason,
      },
      severity: AuditSeverity.WARNING,
    });

    this.publishControlEvent(adminUserId, control, 'deactivated');
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async findActiveControls(): Promise<ExecutionControl[]> {
    const now = new Date();
    const controls = await this.controlRepo.find();
    // Defense-in-depth JS filter (the partial unique index + status column
    // are the authoritative store guarantees): a control counts as active
    // only when status = ACTIVE and its expiry has not passed.
    return controls.filter(
      (c) => c.status === ExecutionControlStatus.ACTIVE && (!c.expiresAt || c.expiresAt > now),
    );
  }

  /**
   * Discover only the persisted ACTIVE row that can occupy the partial-unique
   * slot. Historical EXPIRED rows are intentionally excluded so multi-cycle
   * reactivate/expire history cannot shadow the current row.
   */
  private async findCurrentActiveControl(
    scope: ExecutionControlScope,
    scopeKey: string | null,
  ): Promise<ExecutionControl | null> {
    const where: Record<string, unknown> = {
      scope,
      scopeKey,
      status: ExecutionControlStatus.ACTIVE,
    };
    const control = await this.controlRepo.findOne({
      where,
      order: { activatedAt: 'DESC' },
    });
    if (!control || control.status !== ExecutionControlStatus.ACTIVE) return null;
    return control;
  }

  /**
   * Retire exactly the time-expired ACTIVE row observed by discovery. The
   * status predicate makes a concurrent retire/replacement race benign: if
   * another writer already changed this row, zero affected rows is accepted
   * and the subsequent insert is still arbitrated by the partial unique index.
   */
  private async retireExpiredActiveControl(control: ExecutionControl): Promise<void> {
    const result = await this.controlRepo.update(
      { id: control.id, status: ExecutionControlStatus.ACTIVE },
      { status: ExecutionControlStatus.EXPIRED },
    );
    const affected =
      (result as { affected?: number }).affected ??
      (result as { raw?: { rowCount?: number } }).raw?.rowCount;
    if (affected === 0) {
      this.logger.warn(
        `Execution control ${control.id} was already retired by a concurrent writer; continuing replacement`,
      );
    }
  }

  /** A row blocks execution only when ACTIVE and not yet expired. */
  private isEffectivelyActive(control: ExecutionControl): boolean {
    return (
      control.status === ExecutionControlStatus.ACTIVE &&
      (!control.expiresAt || control.expiresAt > new Date())
    );
  }

  private matchScope(
    controls: ExecutionControl[],
    scope: ExecutionControlScope,
    key: string | null,
  ): ExecutionControl | null {
    const now = Date.now();
    return (
      controls.find(
        (c) =>
          c.scope === scope &&
          (key === null ? c.scopeKey === null : c.scopeKey === key) &&
          c.status === ExecutionControlStatus.ACTIVE &&
          (!c.expiresAt || c.expiresAt.getTime() > now),
      ) ?? null
    );
  }

  private normalizeScopeKey(
    scope: ExecutionControlScope,
    scopeKey: string | null | undefined,
  ): string | null {
    if (scope === ExecutionControlScope.GLOBAL) return null;
    if (!scopeKey || scopeKey.trim().length === 0) {
      throw new ConflictException(`scopeKey is required for scope=${scope}`);
    }
    return scopeKey.trim();
  }

  private toBlock(c: ExecutionControl): ExecutionPermission['blockedBy'] {
    return { scope: c.scope, scopeKey: c.scopeKey, reason: c.reason };
  }

  private toView(c: ExecutionControl): ExecutionControlView {
    return {
      id: c.id,
      scope: c.scope,
      scopeKey: c.scopeKey,
      reason: c.reason,
      activatedByUserId: c.activatedByUserId,
      activatedAt: c.activatedAt,
      expiresAt: c.expiresAt,
    };
  }

  private publishControlEvent(
    adminUserId: string,
    control: ExecutionControl,
    action: 'activated' | 'deactivated',
  ): void {
    // Realtime consumers listen for control-plane changes (§28: immediate effect)
    this.eventBus.publish(DomainEventType.EXECUTION_CONTROL_CHANGED, adminUserId, {
      scope: control.scope,
      scopeKey: control.scopeKey,
      action,
      reason: control.reason,
    });
  }
}
