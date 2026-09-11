import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExecutionMode } from './interfaces/execution-authority';
import { TradingSession, TradingSessionStatus } from './entities/trading-session.entity';

/**
 * Execution-session resolution seam — Round 5, architect issues #295/#298.
 *
 * THE RULE (issue #295): the TradingSession is the authoritative execution
 * target. NEW-exposure decisions NEVER rediscover "the latest active
 * BrokerConnection" (brokerService.findActiveConnectionForUser) — they resolve
 * the user's ACTIVE TradingSession and use its bound brokerConnectionId,
 * authorityGeneration and executionMode. The exact connection was chosen at
 * session start and stays bound until an explicit, audited end+start.
 *
 * This module owns the typed domain errors of the session-authority surface so
 * controllers and services share one vocabulary:
 *   - SessionAuthorityNotActiveException     (403 SESSION_NOT_ACTIVE)
 *   - ActiveSessionConflictException         (409 ACTIVE_SESSION_CONFLICT)
 *   - SessionAuthorityGenerationConflictException (409 SESSION_AUTHORITY_GENERATION_CONFLICT)
 *   - BrokerConnectionOwnershipException     (403 BROKER_CONNECTION_NOT_OWNED)
 *   - BrokerConnectionNotConnectedException  (403 BROKER_CONNECTION_NOT_CONNECTED)
 *   - BrokerConnectionNotExecutableException (403 BROKER_CONNECTION_NOT_EXECUTABLE)
 *   - BrokerConnectionRequiredException      (400 BROKER_CONNECTION_REQUIRED)
 */

/** The authoritative execution target resolved from the ACTIVE session. */
export interface ActiveSessionAuthority {
  sessionId: string;
  /** authorityGeneration at resolution time — binds outstanding RiskGrants. */
  sessionGeneration: number;
  executionMode: ExecutionMode;
  /** EXACT broker connection chosen at session start — never substituted. */
  brokerConnectionId: string;
}

/** No ACTIVE TradingSession exists for the user (issue #295 fail-closed). */
export class SessionAuthorityNotActiveException extends HttpException {
  constructor(userId: string) {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: 'SESSION_NOT_ACTIVE',
        message: 'No active trading session. Start an explicit session before requesting new exposure.',
        userId,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * An ACTIVE session exists but does not match the requested authority target
 * (different broker connection or execution mode). Switching accounts or modes
 * requires an explicit, audited end+start / mode change — never silent
 * substitution (issue #295).
 */
export class ActiveSessionConflictException extends HttpException {
  constructor(details: {
    existingSessionId: string;
    existingBrokerConnectionId: string;
    existingExecutionMode: ExecutionMode;
    requestedBrokerConnectionId: string;
    requestedExecutionMode: ExecutionMode;
  }) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        code: 'ACTIVE_SESSION_CONFLICT',
        message:
          'An active trading session already exists with a different execution target ' +
          '(broker connection or execution mode). End the current session explicitly or use the ' +
          'audited execution-mode change endpoint. Account switching is never performed silently.',
        ...details,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * CAS race on the session authority generation: the observed generation no
 * longer matches the stored row (concurrent mode change / suspension).
 * 0 affected rows → reload + typed conflict — never a blind retry.
 */
export class SessionAuthorityGenerationConflictException extends HttpException {
  constructor(details: {
    sessionId: string;
    observedGeneration: number;
    currentGeneration: number | null;
    currentExecutionMode: ExecutionMode | null;
    currentStatus: TradingSessionStatus | null;
  }) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        code: 'SESSION_AUTHORITY_GENERATION_CONFLICT',
        message:
          'The trading session authority changed concurrently. Reload the session and retry — ' +
          'the change was NOT applied.',
        ...details,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/** Typed ownership rejection — never reveals whether the id exists. */
export class BrokerConnectionOwnershipException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: 'BROKER_CONNECTION_NOT_OWNED',
        message: 'Broker connection not found or does not belong to you.',
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

/** Typed non-CONNECTED rejection at session start. */
export class BrokerConnectionNotConnectedException extends HttpException {
  constructor(status: string) {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: 'BROKER_CONNECTION_NOT_CONNECTED',
        message: `Broker connection is ${status}, not CONNECTED. Connect it before starting a session.`,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

/** Typed LIVE-authorization (fail-closed state machine) rejection. */
export class BrokerConnectionNotExecutableException extends HttpException {
  constructor(authorizationStatus: string) {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: 'BROKER_CONNECTION_NOT_EXECUTABLE',
        message:
          `Broker connection authorization status is ${authorizationStatus} — the connection is ` +
          'not executable. Re-authorize the connection before starting a session.',
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

/** startSession requires the EXACT connection id — no discovery fallback. */
export class BrokerConnectionRequiredException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'BROKER_CONNECTION_REQUIRED',
        message:
          'A specific brokerConnectionId is required to start a trading session. ' +
          'The session binds the exact connection that will execute new exposure — ' +
          'no connection is discovered implicitly.',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * resolveActiveSessionAuthority(userId) — the single seam every EXECUTION-side
 * NEW-exposure decision uses to obtain the authoritative execution target.
 * Orders by authorityGeneration DESC, startedAt DESC and returns a single row
 * so a legacy multi-ACTIVE row state resolves deterministically (the partial
 * unique index makes this unreachable in new data).
 */
@Injectable()
export class ExecutionSessionResolutionService {
  constructor(
    @InjectRepository(TradingSession)
    private readonly sessionRepo: Repository<TradingSession>,
  ) {}

  async resolveActiveSessionAuthority(userId: string): Promise<ActiveSessionAuthority> {
    const session = await this.sessionRepo.findOne({
      where: { userId, status: TradingSessionStatus.ACTIVE },
      order: { authorityGeneration: 'DESC', startedAt: 'DESC' },
    });
    if (!session) {
      throw new SessionAuthorityNotActiveException(userId);
    }
    return {
      sessionId: session.id,
      sessionGeneration: session.authorityGeneration,
      executionMode: session.executionMode,
      brokerConnectionId: session.brokerConnectionId,
    };
  }
}
