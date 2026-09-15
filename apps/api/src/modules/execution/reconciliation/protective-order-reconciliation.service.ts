import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import {
  IBrokerAdapter,
  BrokerPosition,
} from '../../broker/interfaces/broker-adapter.interface';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { BrokerCredentialLifecycle } from '../../broker/authorization/broker-credential-status';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';

/**
 * Round 6 live-execution completion (§8) — per-trade protective-order
 * outcomes. Stable machine codes (§26 naming).
 */
export type ProtectiveOutcome =
  /** Provider SL/TP match the internal authority — nothing to do. */
  | 'PROTECTED'
  /** Provider SL/TP were missing/deviated and were REPAIRED back to the
   *  internal authoritative levels through modifyOrder. */
  | 'REPAIRED'
  /** modifyOrder refused/failed — the trade is unprotected at the provider;
   *  CRITICAL audit escalates for operator action. */
  | 'REPAIR_FAILED'
  /** No provider position for the trade — the STATE reconciliation sweep
   *  owns that discrepancy; this loop never double-acts on it. */
  | 'POSITION_MISSING'
  /** The INTERNAL protective levels are unprovable — repair would invent a
   *  value, so the loop fails closed and escalates. */
  | 'INTERNAL_UNPROVABLE';

/**
 * Provider-side protective-level tolerance: a provider SL/TP within 0.05%
 * of the internal authority is a rounding artifact (providers round to
 * instrument digits), NOT drift. Anything wider is a real deviation.
 */
export const PROTECTIVE_LEVEL_TOLERANCE_RATIO = '0.0005';

export interface ProtectiveReconciliationResult {
  tradeId: string;
  externalOrderId: string;
  outcome: ProtectiveOutcome;
  /** Machine detail for REPAIRED/REPAIR_FAILED/INTERNAL_UNPROVABLE. */
  detail?: string;
}

export interface ProtectiveReconciliationOutcome {
  checked: number;
  protectedCount: number;
  repairedCount: number;
  repairFailedCount: number;
  skippedCount: number;
  /** True when the connection itself could not be reconciled (typed reason
   *  in `reason`) — never a silent skip. */
  status: 'OK' | 'SKIPPED' | 'FAILED';
  reason?: string;
}

/**
 * ProtectiveOrderReconciliationService (Round 6 live-execution completion
 * §8) — the protective-order reconciliation loop.
 *
 * MANDATE: every OPEN position must carry the protective levels the risk
 * engine authorized (trade.stopLoss / trade.takeProfit are the INTERNAL
 * AUTHORITY — they passed the mandatory SL/TP risk gate). Providers can
 * silently drop or shift SL/TP (manual terminal edits, provider incidents,
 * partial-attach races on cTrader MARKET orders). This loop VERIFY-REPAIRS:
 *
 *   1. Reads the provider's CURRENT positions through the same
 *      connection-scoped adapter context as the state sweep.
 *   2. For every OPEN trade with an external order id, compares the
 *      provider-reported SL/TP against the internal authority using
 *      ExactDecimal (tolerance 0.05% = provider digit rounding).
 *   3. MISSING or DEVIATED → ONE repair attempt per cycle through
 *      modifyOrder (restore the internal levels). Repair is risk-REDUCING
 *      (protective): it is deliberately NOT blocked by execution controls.
 *   4. A refused repair is a CRITICAL audit — the position is unprotected
 *      at the provider and a human must act. Never silent, never invented.
 *
 * FAIL-CLOSED properties:
 *   - No provider position → POSITION_MISSING (the state sweep's domain —
 *     never double-acted upon here).
 *   - Unprovable INTERNAL levels → INTERNAL_UNPROVABLE (repairing from an
 *     invented value is forbidden).
 *   - Credential lifecycle unusable → typed SKIPPED (rotate to restore).
 *   - Adapter/provider failure → FAILED with the typed reason; the job
 *     aggregates and the next cycle retries.
 *
 * This service NEVER places/closes orders — modifyOrder of SL/TP only.
 */
@Injectable()
export class ProtectiveOrderReconciliationService {
  private readonly logger = new Logger(ProtectiveOrderReconciliationService.name);

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    private readonly adapterRegistry: BrokerAdapterRegistry,
    private readonly encryptionService: CredentialEncryptionService,
    private readonly auditService: AuditService,
  ) {}

  /** Verify + repair the protective orders of every OPEN trade on ONE connection. */
  async reconcileProtectiveOrders(
    connection: BrokerConnection,
  ): Promise<ProtectiveReconciliationOutcome> {
    const openTrades = await this.tradeRepo.find({
      where: { brokerConnectionId: connection.id, status: TradeStatus.OPEN },
    });
    const candidates = openTrades.filter((t) => !!t.externalOrderId);
    if (candidates.length === 0) {
      return {
        checked: 0,
        protectedCount: 0,
        repairedCount: 0,
        repairFailedCount: 0,
        skippedCount: 0,
        status: 'OK',
      };
    }

    if (!BrokerCredentialLifecycle.isUsable(connection.credentialStatus)) {
      // Typed skip — fail-closed: never reconcile with unusable credentials.
      const reason =
        `credential lifecycle state is ${connection.credentialStatus ?? 'MISSING'}`;
      await this.auditSkip(connection, reason, candidates.length);
      return {
        checked: 0,
        protectedCount: 0,
        repairedCount: 0,
        repairFailedCount: 0,
        skippedCount: candidates.length,
        status: 'SKIPPED',
        reason,
      };
    }

    // Connection-scoped adapter context (same model as the state sweep).
    const adapter = this.adapterRegistry.getAdapterForConnection(
      connection.id,
      connection.brokerId,
    );
    adapter.setMode(connection.accountType);
    const credentials = this.decryptCredentials(connection);
    let positions: BrokerPosition[];
    try {
      await adapter.connect(credentials);
      positions = await adapter.getOpenPositions();
    } catch (err) {
      const reason = `provider unreachable: ${(err as Error).message}`;
      await this.auditSkip(connection, reason, candidates.length);
      return {
        checked: 0,
        protectedCount: 0,
        repairedCount: 0,
        repairFailedCount: 0,
        skippedCount: candidates.length,
        status: 'FAILED',
        reason,
      };
    } finally {
      this.zeroCredentials(credentials);
    }

    const providerByExternalId = new Map(
      positions.map((p) => [p.externalOrderId, p] as const),
    );

    let protectedCount = 0;
    let repairedCount = 0;
    let repairFailedCount = 0;
    let skippedCount = 0;
    const failures: ProtectiveReconciliationResult[] = [];

    for (const trade of candidates) {
      const result = await this.verifyAndRepairOne(
        trade,
        adapter,
        providerByExternalId.get(trade.externalOrderId as string) ?? null,
      );
      switch (result.outcome) {
        case 'PROTECTED':
          protectedCount++;
          break;
        case 'REPAIRED':
          repairedCount++;
          break;
        case 'REPAIR_FAILED':
          repairFailedCount++;
          failures.push(result);
          break;
        default:
          skippedCount++;
          break;
      }
    }

    await this.auditService.log({
      actorUserId: connection.userId,
      action: AuditAction.PROTECTIVE_ORDER_RECONCILED,
      resourceType: 'BrokerConnection',
      resourceId: connection.id,
      severity: repairFailedCount > 0 ? AuditSeverity.CRITICAL : AuditSeverity.INFO,
      metadata: {
        checked: candidates.length,
        protectedCount,
        repairedCount,
        repairFailedCount,
        skippedCount,
        failures: failures.map((f) => ({
          tradeId: f.tradeId,
          outcome: f.outcome,
          detail: f.detail ?? null,
        })),
      },
    });

    return {
      checked: candidates.length,
      protectedCount,
      repairedCount,
      repairFailedCount,
      skippedCount,
      status: repairFailedCount > 0 ? 'FAILED' : 'OK',
    };
  }

  // ─── Per-trade verify + repair ────────────────────────────────────────────

  private async verifyAndRepairOne(
    trade: Trade,
    adapter: IBrokerAdapter,
    position: BrokerPosition | null,
  ): Promise<ProtectiveReconciliationResult> {
    const externalOrderId = trade.externalOrderId as string;

    if (!position) {
      // The STATE sweep owns position-presence discrepancies — never act.
      return { tradeId: trade.id, externalOrderId, outcome: 'POSITION_MISSING' };
    }

    // The internal authority must itself be provable — repair never invents.
    const internalSl = ExactDecimal.tryParse(trade.stopLoss ?? '');
    const internalTp = ExactDecimal.tryParse(trade.takeProfit ?? '');
    if (!internalSl?.isPositive() || !internalTp?.isPositive()) {
      const detail = 'internal SL/TP are not provable positive decimals';
      await this.auditTradeFailure(trade, 'INTERNAL_UNPROVABLE', detail);
      return { tradeId: trade.id, externalOrderId, outcome: 'INTERNAL_UNPROVABLE', detail };
    }

    const providerSl = ExactDecimal.tryParse(position.stopLoss ?? '');
    const providerTp = ExactDecimal.tryParse(position.takeProfit ?? '');

    const slOk =
      providerSl?.isPositive() === true &&
      this.withinTolerance(providerSl, internalSl);
    const tpOk =
      providerTp?.isPositive() === true &&
      this.withinTolerance(providerTp, internalTp);

    if (slOk && tpOk) {
      return { tradeId: trade.id, externalOrderId, outcome: 'PROTECTED' };
    }

    // MISSING or DEVIATED at the provider → ONE repair attempt this cycle:
    // restore the INTERNAL authoritative protective levels (risk-reducing).
    const detail = !providerSl?.isPositive()
      ? 'provider SL missing'
      : !slOk
        ? `provider SL deviated (${position.stopLoss} vs authority ${trade.stopLoss})`
        : !providerTp?.isPositive()
          ? 'provider TP missing'
          : `provider TP deviated (${position.takeProfit} vs authority ${trade.takeProfit})`;

    try {
      const result = await adapter.modifyOrder(externalOrderId, {
        newStopLoss: trade.stopLoss as string,
        newTakeProfit: trade.takeProfit as string,
      });
      if (result.success) {
        this.logger.warn(
          `Protective orders REPAIRED for trade ${trade.id} (${trade.instrument}): ${detail}`,
        );
        await this.auditService.log({
          actorUserId: trade.userId,
          action: AuditAction.PROTECTIVE_ORDER_RECONCILED,
          resourceType: 'Trade',
          resourceId: trade.id,
          severity: AuditSeverity.WARNING,
          metadata: {
            outcome: 'REPAIRED',
            instrument: trade.instrument,
            externalOrderId,
            detail,
            restoredStopLoss: trade.stopLoss,
            restoredTakeProfit: trade.takeProfit,
          },
        });
        return { tradeId: trade.id, externalOrderId, outcome: 'REPAIRED', detail };
      }
      const failDetail = `modifyOrder returned success=false: ${detail}`;
      await this.auditTradeFailure(trade, 'REPAIR_FAILED', failDetail);
      return { tradeId: trade.id, externalOrderId, outcome: 'REPAIR_FAILED', detail: failDetail };
    } catch (err) {
      const failDetail = `modifyOrder threw: ${(err as Error).message} (${detail})`;
      await this.auditTradeFailure(trade, 'REPAIR_FAILED', failDetail);
      return { tradeId: trade.id, externalOrderId, outcome: 'REPAIR_FAILED', detail: failDetail };
    }
  }

  /** |provider − internal| / internal ≤ tolerance (provider digit rounding). */
  private withinTolerance(provider: ExactDecimal, internal: ExactDecimal): boolean {
    const deviation = provider.sub(internal).abs().div(internal, { scale: 10 });
    return deviation.lte(ExactDecimal.parse(PROTECTIVE_LEVEL_TOLERANCE_RATIO));
  }

  // ─── Credential handling (state-sweep pattern) ────────────────────────────

  private decryptCredentials(connection: BrokerConnection): {
    accountId: string;
    apiKey?: string;
    apiSecret?: string;
    serverUrl?: string;
  } {
    if (
      connection.encryptedCredentials &&
      connection.credentialIv &&
      connection.credentialTag
    ) {
      return this.encryptionService.decrypt({
        ciphertext: connection.encryptedCredentials,
        iv: connection.credentialIv,
        tag: connection.credentialTag,
        keyId: connection.encryptionKeyId ?? 'env-key-v1',
      }) as { accountId: string; apiKey?: string; apiSecret?: string; serverUrl?: string };
    }
    // No stored credential blob (e.g. paper connections) — the safe account
    // reference is all adapters need to address the account (state-sweep
    // pattern).
    return { accountId: connection.accountId ?? '' };
  }

  private zeroCredentials(credentials: Record<string, unknown>): void {
    for (const key of Object.keys(credentials)) {
      credentials[key] = null;
    }
  }

  // ─── Audit helpers ────────────────────────────────────────────────────────

  private async auditTradeFailure(
    trade: Trade,
    outcome: ProtectiveOutcome,
    detail: string,
  ): Promise<void> {
    this.logger.error(
      `Protective-order reconciliation ${outcome} for trade ${trade.id} ` +
        `(${trade.instrument}): ${detail}`,
    );
    await this.auditService.log({
      actorUserId: trade.userId,
      action: AuditAction.PROTECTIVE_ORDER_RECONCILED,
      resourceType: 'Trade',
      resourceId: trade.id,
      severity: AuditSeverity.CRITICAL,
      metadata: {
        outcome,
        instrument: trade.instrument,
        externalOrderId: trade.externalOrderId,
        detail,
      },
    });
  }

  private async auditSkip(
    connection: BrokerConnection,
    reason: string,
    tradeCount: number,
  ): Promise<void> {
    this.logger.warn(
      `Protective-order reconciliation skipped for connection ${connection.id}: ${reason}`,
    );
    await this.auditService.log({
      actorUserId: connection.userId,
      action: AuditAction.PROTECTIVE_ORDER_RECONCILED,
      resourceType: 'BrokerConnection',
      resourceId: connection.id,
      severity: AuditSeverity.WARNING,
      metadata: {
        outcome: 'SKIPPED',
        reason,
        openTrades: tradeCount,
      },
    });
  }
}
