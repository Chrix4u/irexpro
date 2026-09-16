import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TradingService } from './trading.service';
import { StartSessionDto } from './dto/start-session.dto';
import { ChangeExecutionModeDto } from './dto/change-execution-mode.dto';
import {
  TradingSessionResponseDto,
  toTradingSessionResponse,
} from './dto/trading-session-response.dto';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { ExecutionMode } from '../execution/interfaces/execution-authority';

/**
 * TradingController — Trading session lifecycle API.
 *
 * All routes are protected by the global JwtAuthGuard.
 *
 * POST /api/v1/trading/sessions/start       — start a new trading session
 * POST /api/v1/trading/sessions/:id/stop    — stop a specific session
 * POST /api/v1/trading/sessions/:id/mode    — audited execution-mode change
 * GET  /api/v1/trading/sessions/active      — get current active session
 * GET  /api/v1/trading/sessions/:id         — get session by ID
 *
 * All session actions require:
 *   - Valid JWT (global guard)
 *   - Completed onboarding (profile + risk + broker connected — enforced in
 *     TradingService via OnboardingService.canStartTrading)
 *   - Active broker connection (enforced in TradingService)
 *   - Kill switch not active (enforced in TradingService)
 *
 * Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
 *   Trading is NO LONGER gated on a paid subscription. iRexPro operates on a
 *   performance-fee-only model — users may start trading (paper or live) after
 *   completing onboarding, and a performance fee is assessed only when their
 *   trading generates qualifying realised profit above the high-water mark.
 *   The legacy "active subscription with allowsAiAutoTrading" gate is gone.
 *
 * Frontend safety boundary:
 *   Session endpoints return TradingSessionResponseDto rather than the raw
 *   TypeORM entity. Internal audit snapshots and financial session fields are
 *   deliberately excluded from browser-facing responses.
 */
@ApiTags('Trading')
@Controller('trading/sessions')
export class TradingController {
  private readonly logger = new Logger(TradingController.name);

  constructor(private readonly tradingService: TradingService) {}

  /**
   * Start a trading session.
   *
   * Enforces: onboarding gate, broker gate, kill switch gate.
   * Demo mode is the broker default until explicitly changed.
   *
   * Subscription-retirement (SUBSCRIPTION-RETIREMENT-IMPL):
   *   No subscription is required to start trading — the only gates are
   *   onboarding completion, broker connection, and kill switch state.
   *   Monetization is handled separately via the performance-fee flow.
   *
   * POST /api/v1/trading/sessions/start
   */
  @Post('start')
  @ApiOperation({
    summary: 'Start a new AI trading session',
    description:
      'Requires onboarding complete (profile + risk acknowledgement + broker connected), ' +
      'the EXACT brokerConnectionId to bind (no implicit discovery), a healthy broker ' +
      'connection, and kill switch inactive. No subscription is required ' +
      '(performance-fee-only model). executionMode defaults to PAPER_ONLY; it is persisted ' +
      'on the session and binds all future NEW-exposure decisions (Round 5 session ' +
      'authority). FULL_AUTO does NOT automatically enable live broker execution — live ' +
      'trading requires a separate explicit enablement on the broker connection.',
  })
  @ApiResponse({ status: 201, type: TradingSessionResponseDto })
  async startSession(
    @CurrentUserId() userId: string,
    @Body() dto: StartSessionDto,
  ): Promise<TradingSessionResponseDto> {
    const session = await this.tradingService.startTradingSession(
      userId,
      dto.brokerConnectionId,
      this.resolveExecutionMode(dto),
    );
    return toTradingSessionResponse(session);
  }

  /**
   * Resolve the durable execution mode from the DTO (Round 5, #298).
   *
   * `executionMode` is authoritative; the legacy `requestedMode` alias is kept
   * for backward compatibility. Both supplied and disagreeing → 400 (never a
   * silent pick — the mode is part of the session authority).
   */
  private resolveExecutionMode(dto: StartSessionDto): ExecutionMode {
    if (
      dto.executionMode &&
      dto.requestedMode &&
      String(dto.executionMode) !== String(dto.requestedMode)
    ) {
      throw new BadRequestException(
        'requestedMode and executionMode disagree. Supply only executionMode ' +
          '(requestedMode is a deprecated alias with the same values).',
      );
    }
    return (
      dto.executionMode ??
      (dto.requestedMode as ExecutionMode | undefined) ??
      ExecutionMode.PAPER_ONLY
    );
  }

  /**
   * Stop a specific trading session.
   *
   * Only the session owner can stop their own session.
   * Does NOT auto-close open trades in this sprint.
   *
   * POST /api/v1/trading/sessions/:id/stop
   */
  @Post(':id/stop')
  @ApiOperation({
    summary: 'Stop an active trading session',
    description:
      'Stops the specified session. Does not automatically close open trades. ' +
      'Invalidates outstanding RiskGrants / SEMI_AUTO confirmations bound to the session. ' +
      'Emits a realtime session-stopped event.',
  })
  async stopSession(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ): Promise<{ message: string; sessionId: string }> {
    await this.tradingService.stopTradingSession(userId, sessionId);
    return { message: 'Trading session stopped', sessionId };
  }

  /**
   * Explicit + audited execution-mode change (Round 5, issue #298).
   *
   * Bumps the session authorityGeneration via CAS, INVALIDATES outstanding
   * ACTIVE RiskGrants (reason SESSION_AUTHORITY_GENERATION_CHANGED — never
   * revived) and REVOKES PENDING SEMI_AUTO confirmations. Requires the session
   * to be ACTIVE and owned by the caller; the new mode must be permitted by
   * the user's risk profile (FULL_AUTO additionally requires live enablement
   * on the session's bound connection).
   *
   * POST /api/v1/trading/sessions/:id/mode
   */
  @Post(':id/mode')
  @ApiOperation({
    summary: 'Change the execution mode of an active session (audited)',
    description:
      'Explicit, audited execution-mode change. Advances authorityGeneration ' +
      '(CAS) and invalidates all outstanding authority bound to the previous ' +
      'generation: ACTIVE RiskGrants become INVALIDATED with reason ' +
      'SESSION_AUTHORITY_GENERATION_CHANGED, PENDING confirmations become REVOKED. ' +
      'Grants are never revived when switching back — a new risk evaluation is required.',
  })
  @ApiResponse({ status: 200, type: TradingSessionResponseDto })
  async changeExecutionMode(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Body() dto: ChangeExecutionModeDto,
  ): Promise<TradingSessionResponseDto> {
    const session = await this.tradingService.changeExecutionMode(
      userId,
      sessionId,
      dto.executionMode,
    );
    return toTradingSessionResponse(session);
  }

  /**
   * Get the current active session for the authenticated user.
   *
   * GET /api/v1/trading/sessions/active
   */
  @Get('active')
  @ApiOperation({ summary: 'Get the current active trading session' })
  @ApiResponse({ status: 200, type: TradingSessionResponseDto })
  async getActive(@CurrentUserId() userId: string): Promise<TradingSessionResponseDto | null> {
    const session = await this.tradingService.getActiveSession(userId);
    return session ? toTradingSessionResponse(session) : null;
  }

  /**
   * Get a specific session by ID (must belong to authenticated user).
   *
   * GET /api/v1/trading/sessions/:id
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a trading session by ID' })
  @ApiResponse({ status: 200, type: TradingSessionResponseDto })
  async getById(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ): Promise<TradingSessionResponseDto> {
    const session = await this.tradingService.getSessionById(userId, sessionId);
    if (!session) {
      throw new NotFoundException(`Trading session ${sessionId} not found`);
    }
    return toTradingSessionResponse(session);
  }
}
