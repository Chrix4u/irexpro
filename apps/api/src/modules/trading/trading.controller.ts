import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TradingService, type StopTradingSessionResult } from './trading.service';
import { StartSessionDto } from './dto/start-session.dto';
import { ChangeExecutionModeDto } from './dto/change-execution-mode.dto';
import { UpdateAdvancedAiControlsDto } from './dto/update-advanced-ai-controls.dto';
import {
  ActiveTradingSessionResponseDto,
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

  constructor(
    private readonly tradingService: TradingService,
    private readonly configService: ConfigService,
  ) {}

  @Get('advanced-controls')
  @ApiOperation({ summary: 'Read step-up-protected Advanced AI Controls' })
  async getAdvancedControls(
    @CurrentUserId() userId: string,
    @Headers('x-irexpro-step-up') stepUpToken?: string,
  ) {
    if (!stepUpToken) throw new BadRequestException('Step-up authorization is required');
    return this.tradingService.getAdvancedAiControls(userId, stepUpToken);
  }

  @Post('advanced-controls')
  @ApiOperation({ summary: 'Update LIVE-promotable Advanced AI Controls' })
  async updateAdvancedControls(
    @CurrentUserId() userId: string,
    @Headers('x-irexpro-step-up') stepUpToken: string | undefined,
    @Body() dto: UpdateAdvancedAiControlsDto,
  ) {
    if (!stepUpToken) throw new BadRequestException('Step-up authorization is required');
    return this.tradingService.updateAdvancedAiControls(
      userId,
      stepUpToken,
      dto.executionConfidenceFloor,
    );
  }

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
    const executionMode = this.resolveExecutionMode(dto);
    this.assertVpsScannerPaperAuthority(userId, dto.brokerConnectionId, executionMode);

    const session = await this.tradingService.startTradingSession(
      userId,
      dto.brokerConnectionId,
      executionMode,
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
   * Research authority lock for the VPS-native multi-model campaign.
   *
   * A real-provider DEMO connection may stay connected for broker-native MTF
   * market data and parity validation, but it must not become an execution
   * target merely because a user selects it in the generic trading UI. While
   * the configured research user is owned by vpsForexScanner, session starts
   * are fail-closed to the exact configured PAPER connection in PAPER_ONLY.
   * DEMO/LIVE promotion therefore requires an explicit future promotion
   * change rather than an accidental generic Start or mode-change request.
   */
  private assertVpsScannerPaperAuthority(
    userId: string,
    brokerConnectionId: string,
    executionMode: ExecutionMode,
  ): void {
    if (this.configService.get<boolean>('vpsForexScanner.enabled', false) !== true) return;

    const configuredUserId = this.configService
      .get<string>('vpsForexScanner.userId', '')
      .trim();
    const apiKey = this.configService.get<string>('vpsForexScanner.apiKey', '').trim();
    if (!apiKey || apiKey.toLowerCase() === 'demo' || configuredUserId !== userId) return;

    const configuredPaperConnectionId = this.configService
      .get<string>('vpsForexScanner.brokerConnectionId', '')
      .trim();
    const exactPaperAuthority =
      Boolean(configuredPaperConnectionId) &&
      brokerConnectionId === configuredPaperConnectionId &&
      executionMode === ExecutionMode.PAPER_ONLY;

    if (exactPaperAuthority) return;

    throw new ForbiddenException(
      'The iRexPro multi-model research campaign is PAPER-only. Keep MetaApi connected ' +
        'for broker-native data and parity validation; DEMO/LIVE execution remains locked ' +
        'until an explicit strategy promotion.',
    );
  }

  private assertVpsScannerPaperMode(userId: string, executionMode: ExecutionMode): void {
    if (this.configService.get<boolean>('vpsForexScanner.enabled', false) !== true) return;

    const configuredUserId = this.configService
      .get<string>('vpsForexScanner.userId', '')
      .trim();
    const apiKey = this.configService.get<string>('vpsForexScanner.apiKey', '').trim();
    if (!apiKey || apiKey.toLowerCase() === 'demo' || configuredUserId !== userId) return;

    if (executionMode !== ExecutionMode.PAPER_ONLY) {
      throw new ForbiddenException(
        'The iRexPro multi-model research campaign is locked to PAPER_ONLY. ' +
          'DEMO/LIVE execution requires an explicit strategy promotion.',
      );
    }
  }

  /**
   * Stop a specific trading session.
   *
   * Only the session owner can stop their own session. The server ends
   * execution authority first, then requests closure of AI-proven OPEN
   * positions and returns an honest closure summary.
   *
   * POST /api/v1/trading/sessions/:id/stop
   */
  @Post(':id/stop')
  @ApiOperation({
    summary: 'Stop an active trading session',
    description:
      'Stops the specified session, invalidates outstanding RiskGrants / SEMI_AUTO ' +
      'confirmations, then requests closure of every OPEN position with durable iRexPro ' +
      'AI provenance. The response reports confirmed versus unresolved closures; ' +
      'unresolved broker outcomes remain visible for reconciliation.',
  })
  async stopSession(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ): Promise<StopTradingSessionResult> {
    return this.tradingService.stopTradingSession(userId, sessionId);
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
    this.assertVpsScannerPaperMode(userId, dto.executionMode);

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
  @ApiResponse({ status: 200, type: ActiveTradingSessionResponseDto })
  async getActive(@CurrentUserId() userId: string): Promise<ActiveTradingSessionResponseDto> {
    const session = await this.tradingService.getActiveSession(userId);
    return {
      session: session ? toTradingSessionResponse(session) : null,
    };
  }

  @Get(':id/automation-status')
  @ApiOperation({ summary: 'Get AI automation runtime status for a trading session' })
  async getAutomationStatus(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) sessionId: string,
  ) {
    return this.tradingService.getAutomationRuntimeStatus(userId, sessionId);
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
