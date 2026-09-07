import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Server } from 'socket.io';
import { Repository } from 'typeorm';
import { DomainEventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/enums/domain-event-type.enum';
import {
  TradingSessionEventPayload,
  TradeEventPayload,
  OrderEventPayload,
  RiskDecisionEventPayload,
  BrokerStatusEventPayload,
  BrokerAuthorizationEventPayload,
  ExecutionControlEventPayload,
  AiSignalEventPayload,
  SystemNotificationPayload,
  ReconciliationRunEventPayload,
  ReconciliationDiscrepancyEventPayload,
} from '../events/interfaces/domain-event.interface';
import { User, UserStatus } from '../users/entities/user.entity';
import { RealtimeEvent } from './events/realtime-event.enum';

/**
 * RealtimeService — Manages WebSocket room membership and event emission.
 *
 * Outbound delivery is session-aware: room membership by itself is never
 * treated as continuing authorization. Before a user/session-room payload is
 * emitted, each socket's authenticated session generation is compared with
 * the current identity.users row. Revoked or inactive sockets are disconnected
 * and receive no payload. Store-read failures fail closed.
 *
 * Payload safety: no credentials, no tokens, no stack traces ever emitted.
 *
 * See: docs/architecture/06-realtime-event-layer.md
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly eventBus: DomainEventBus,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /** Called by RealtimeGateway once the WebSocket server is ready. */
  setServer(server: Server): void {
    this.server = server;
  }

  onModuleInit(): void {
    this.subscribeToEvents();
    this.logger.log('RealtimeService subscribed to DomainEventBus');
  }

  onModuleDestroy(): void {
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers.length = 0;
  }

  // ─── Direct emit methods ───────────────────────────────────────────────────

  async emitToUser(
    userId: string,
    event: RealtimeEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.emitToValidatedRoom(`user:${userId}`, event, payload, userId);
  }

  async emitToTradingSession(
    sessionId: string,
    event: RealtimeEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.emitToValidatedRoom(`trading-session:${sessionId}`, event, payload);
  }

  emitToAdmins(event: RealtimeEvent, payload: Record<string, unknown>): void {
    if (!this.server) return;
    this.server.to('admin:global').emit(event, payload);
    this.logger.debug(`Emitted ${event} to admin:global`);
  }

  /**
   * Emit to sockets only after checking that their connection-time generation
   * is still current. Room membership is a routing hint, never authorization.
   */
  private async emitToValidatedRoom(
    room: string,
    event: RealtimeEvent,
    payload: Record<string, unknown>,
    expectedUserId?: string,
  ): Promise<void> {
    if (!this.server) return;

    let sockets: Awaited<ReturnType<ReturnType<Server['in']>['fetchSockets']>>;
    try {
      sockets = await this.server.in(room).fetchSockets();
    } catch (error) {
      this.logger.error(
        `Realtime room lookup failed closed for ${room}: ${(error as Error).message}`,
      );
      return;
    }

    const userStateCache = new Map<
      string,
      { status: UserStatus; sessionVersion: number } | null
    >();

    for (const socket of sockets) {
      const socketUserId =
        typeof socket.data?.userId === 'string' ? (socket.data.userId as string) : null;
      const authenticatedVersion = Number.isInteger(socket.data?.authenticatedSessionVersion)
        ? (socket.data.authenticatedSessionVersion as number)
        : null;

      if (
        !socketUserId ||
        authenticatedVersion === null ||
        (expectedUserId !== undefined && socketUserId !== expectedUserId)
      ) {
        socket.disconnect(true);
        continue;
      }

      let current = userStateCache.get(socketUserId);
      if (current === undefined) {
        try {
          const user = await this.userRepo.findOne({
            where: { id: socketUserId },
            select: ['id', 'status', 'sessionVersion'],
          });
          current = user
            ? {
                status: user.status,
                sessionVersion: Number.isInteger(user.sessionVersion) ? user.sessionVersion : 0,
              }
            : null;
          userStateCache.set(socketUserId, current);
        } catch (error) {
          this.logger.error(
            `Realtime session state unavailable for user ${socketUserId}: ${(error as Error).message}`,
          );
          socket.disconnect(true);
          continue;
        }
      }

      if (
        !current ||
        current.status === UserStatus.SUSPENDED ||
        current.status === UserStatus.PERMANENTLY_LOCKED ||
        current.status === UserStatus.CLOSED
      ) {
        socket.disconnect(true);
        continue;
      }

      if (current.sessionVersion !== authenticatedVersion) {
        socket.disconnect(true);
        continue;
      }

      socket.emit(event, payload);
    }

    this.logger.debug(`Validated outbound ${event} delivery for ${room}`);
  }

  // ─── DomainEventBus subscriptions ─────────────────────────────────────────

  private subscribeToEvents(): void {
    this.unsubscribers.push(
      this.eventBus.subscribe<TradingSessionEventPayload>(
        DomainEventType.TRADING_SESSION_STARTED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.TRADING_SESSION_STARTED, {
            sessionId: payload.sessionId,
            brokerConnectionId: payload.brokerConnectionId,
            status: payload.status,
            startedAt: payload.startedAt,
          });
        },
      ),

      this.eventBus.subscribe<TradingSessionEventPayload>(
        DomainEventType.TRADING_SESSION_STOPPED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.TRADING_SESSION_STOPPED, {
            sessionId: payload.sessionId,
            status: payload.status,
            endedAt: payload.endedAt,
          });
        },
      ),

      this.eventBus.subscribe<TradeEventPayload>(
        DomainEventType.TRADE_PENDING,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.TRADE_PENDING, {
            tradeId: payload.tradeId,
            instrument: payload.instrument,
            direction: payload.direction,
            volume: payload.volume,
            status: payload.status,
          });
        },
      ),

      this.eventBus.subscribe<TradeEventPayload>(
        DomainEventType.TRADE_OPENED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.TRADE_OPENED, {
            tradeId: payload.tradeId,
            instrument: payload.instrument,
            direction: payload.direction,
            volume: payload.volume,
            entryPrice: payload.entryPrice,
            status: payload.status,
          });
          if (payload.sessionId) {
            void this.emitToTradingSession(payload.sessionId, RealtimeEvent.TRADE_OPENED, {
              tradeId: payload.tradeId,
              instrument: payload.instrument,
              direction: payload.direction,
              volume: payload.volume,
              entryPrice: payload.entryPrice,
              status: payload.status,
            });
          }
        },
      ),

      this.eventBus.subscribe<TradeEventPayload>(
        DomainEventType.TRADE_REJECTED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.TRADE_REJECTED, {
            tradeId: payload.tradeId,
            instrument: payload.instrument,
            direction: payload.direction,
            reason: payload.reason,
            status: payload.status,
          });
        },
      ),

      this.eventBus.subscribe<TradeEventPayload>(
        DomainEventType.TRADE_CLOSED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.TRADE_CLOSED, {
            tradeId: payload.tradeId,
            instrument: payload.instrument,
            direction: payload.direction,
            exitPrice: payload.exitPrice,
            realisedPnl: payload.realisedPnl,
            reason: payload.reason,
            status: payload.status,
          });
        },
      ),

      this.eventBus.subscribe<RiskDecisionEventPayload>(
        DomainEventType.RISK_SIGNAL_APPROVED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.RISK_SIGNAL_APPROVED, {
            instrument: payload.instrument,
            direction: payload.direction,
            decision: payload.decision,
          });
        },
      ),

      this.eventBus.subscribe<RiskDecisionEventPayload>(
        DomainEventType.RISK_SIGNAL_REJECTED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.RISK_SIGNAL_REJECTED, {
            instrument: payload.instrument,
            direction: payload.direction,
            decision: payload.decision,
            rejectionCode: payload.rejectionCode,
            rejectionReason: payload.rejectionReason,
          });
        },
      ),

      this.eventBus.subscribe<OrderEventPayload>(
        DomainEventType.ORDER_SUBMITTED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.ORDER_SUBMITTED, {
            orderId: payload.orderId,
            clientOrderId: payload.clientOrderId,
            instrument: payload.instrument,
            direction: payload.direction,
            orderKind: payload.orderKind,
            status: payload.status,
            requestedQuantity: payload.requestedQuantity,
          });
        },
      ),

      this.eventBus.subscribe<OrderEventPayload>(
        DomainEventType.ORDER_ACKNOWLEDGED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.ORDER_ACKNOWLEDGED, {
            orderId: payload.orderId,
            clientOrderId: payload.clientOrderId,
            instrument: payload.instrument,
            status: payload.status,
            providerOrderId: payload.providerOrderId ?? null,
          });
        },
      ),

      this.eventBus.subscribe<OrderEventPayload>(
        DomainEventType.ORDER_FILLED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.ORDER_FILLED, {
            orderId: payload.orderId,
            clientOrderId: payload.clientOrderId,
            instrument: payload.instrument,
            status: payload.status,
            filledQuantity: payload.filledQuantity,
            avgFillPrice: payload.avgFillPrice,
          });
        },
      ),

      this.eventBus.subscribe<OrderEventPayload>(
        DomainEventType.ORDER_REJECTED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.ORDER_REJECTED, {
            orderId: payload.orderId,
            clientOrderId: payload.clientOrderId,
            instrument: payload.instrument,
            status: payload.status,
            reason: payload.reason,
          });
        },
      ),

      this.eventBus.subscribe<OrderEventPayload>(
        DomainEventType.ORDER_RECONCILIATION_PENDING,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.ORDER_RECONCILIATION_PENDING, {
            orderId: payload.orderId,
            clientOrderId: payload.clientOrderId,
            instrument: payload.instrument,
            status: payload.status,
            reason: payload.reason,
          });
        },
      ),

      this.eventBus.subscribe<TradeEventPayload>(
        DomainEventType.TRADE_RECONCILIATION_PENDING,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.TRADE_RECONCILIATION_PENDING, {
            tradeId: payload.tradeId,
            instrument: payload.instrument,
            direction: payload.direction,
            volume: payload.volume,
            status: payload.status,
            reason: payload.reason,
          });
        },
      ),

      this.eventBus.subscribe<ReconciliationRunEventPayload>(
        DomainEventType.RECONCILIATION_RUN_COMPLETED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.RECONCILIATION_RUN_COMPLETED, {
            runId: payload.runId,
            brokerConnectionId: payload.brokerConnectionId,
            brokerId: payload.brokerId,
            status: payload.status,
            discrepanciesDetected: payload.discrepanciesDetected,
            discrepanciesNew: payload.discrepanciesNew,
            discrepanciesOpen: payload.discrepanciesOpen,
            completedAt: payload.completedAt,
          });
        },
      ),

      this.eventBus.subscribe<ReconciliationDiscrepancyEventPayload>(
        DomainEventType.RECONCILIATION_DISCREPANCY_DETECTED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.RECONCILIATION_DISCREPANCY_DETECTED, {
            discrepancyId: payload.discrepancyId,
            brokerConnectionId: payload.brokerConnectionId,
            type: payload.type,
            severity: payload.severity,
            internalRefType: payload.internalRefType ?? null,
            internalRefId: payload.internalRefId ?? null,
            providerRef: payload.providerRef ?? null,
            clientOrderId: payload.clientOrderId ?? null,
            detectedAt: payload.at,
          });
        },
      ),

      this.eventBus.subscribe<ReconciliationDiscrepancyEventPayload>(
        DomainEventType.RECONCILIATION_DISCREPANCY_RESOLVED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.RECONCILIATION_DISCREPANCY_RESOLVED, {
            discrepancyId: payload.discrepancyId,
            brokerConnectionId: payload.brokerConnectionId,
            type: payload.type,
            severity: payload.severity,
            internalRefType: payload.internalRefType ?? null,
            internalRefId: payload.internalRefId ?? null,
            providerRef: payload.providerRef ?? null,
            clientOrderId: payload.clientOrderId ?? null,
            resolvedAt: payload.at,
          });
        },
      ),

      this.eventBus.subscribe<BrokerStatusEventPayload>(
        DomainEventType.BROKER_STATUS_CHANGED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.BROKER_CONNECTION_STATUS_CHANGED, {
            connectionId: payload.connectionId,
            status: payload.status,
            previousStatus: payload.previousStatus,
            reason: payload.reason,
          });
        },
      ),

      this.eventBus.subscribe<BrokerAuthorizationEventPayload>(
        DomainEventType.BROKER_AUTHORIZATION_CHANGED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.BROKER_AUTHORIZATION_CHANGED, {
            connectionId: payload.connectionId,
            brokerId: payload.brokerId,
            status: payload.status,
            previousStatus: payload.previousStatus,
          });
        },
      ),

      this.eventBus.subscribe<ExecutionControlEventPayload>(
        DomainEventType.EXECUTION_CONTROL_CHANGED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.EXECUTION_CONTROL_CHANGED, {
            scope: payload.scope,
            scopeKey: payload.scopeKey ?? null,
            action: payload.action,
            reason: payload.reason,
          });
        },
      ),

      this.eventBus.subscribe<AiSignalEventPayload>(
        DomainEventType.AI_SIGNAL_RECEIVED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.AI_SIGNAL_RECEIVED, {
            signalId: payload.signalId,
            instrument: payload.instrument,
            direction: payload.direction,
            confidenceScore: payload.confidenceScore,
            strategyCode: payload.strategyCode,
          });
        },
      ),

      this.eventBus.subscribe<AiSignalEventPayload>(
        DomainEventType.AI_SIGNAL_IGNORED,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.AI_SIGNAL_IGNORED, {
            signalId: payload.signalId,
            instrument: payload.instrument,
            direction: payload.direction,
            ignoredReason: payload.ignoredReason,
          });
        },
      ),

      this.eventBus.subscribe<SystemNotificationPayload>(
        DomainEventType.SYSTEM_NOTIFICATION,
        ({ userId, payload }) => {
          void this.emitToUser(userId, RealtimeEvent.SYSTEM_NOTIFICATION, {
            title: payload.title,
            message: payload.message,
            severity: payload.severity,
            code: payload.code,
          });
        },
      ),
    );
  }
}
