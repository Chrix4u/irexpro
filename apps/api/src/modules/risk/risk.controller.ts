import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RiskService } from './risk.service';
import { ToggleKillSwitchDto } from './dto/kill-switch.dto';
import { UpdateRiskProfileDto } from './dto/update-risk-profile.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { toRiskProfileResponse, toRiskViolationSummary } from './risk-response.mapper';

/**
 * RiskController — User-facing risk management endpoints.
 *
 * Endpoints:
 *   POST   /risk/kill-switch         — Activate or deactivate personal kill switch
 *   GET    /risk/profile             — Get current risk profile
 *   PATCH  /risk/profile             — Update risk limits
 *   GET    /risk/violations          — Get recent sanitized risk violations
 *   GET    /risk/status              — Quick status summary
 */
@ApiTags('Risk Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('risk')
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  // ─── Kill switch ──────────────────────────────────────────────────────────

  @Post('kill-switch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate or deactivate the personal kill switch',
    description:
      'When activated, ALL AI trading signals for this user are immediately REJECTED. ' +
      'Use this to instantly halt all automated trading. ' +
      'Can be toggled back off to resume trading.',
  })
  @ApiResponse({ status: 200, description: 'Kill switch state updated' })
  async toggleKillSwitch(@Body() dto: ToggleKillSwitchDto, @CurrentUserId() userId: string) {
    const profile = await this.riskService.toggleKillSwitch(userId, dto.active, dto.reason);
    return {
      killSwitchActive: profile.killSwitchActive,
      killSwitchReason: profile.killSwitchReason,
      message: dto.active
        ? 'Kill switch ACTIVATED — all AI trading is now suspended'
        : 'Kill switch DEACTIVATED — AI trading can resume',
    };
  }

  // ─── Risk profile ─────────────────────────────────────────────────────────

  @Get('profile')
  @ApiOperation({ summary: 'Get your current risk profile and limits' })
  @ApiResponse({ status: 200, description: 'Current risk profile' })
  async getRiskProfile(@CurrentUserId() userId: string) {
    const profile = await this.riskService.getOrCreateProfile(userId);
    return toRiskProfileResponse(profile);
  }

  @Patch('profile')
  @ApiOperation({
    summary: 'Update your risk limits',
    description:
      'Update individual risk parameters. Changes take effect on the NEXT signal. ' +
      'Open trades are not retroactively affected.',
  })
  @ApiResponse({ status: 200, description: 'Updated risk profile' })
  async updateRiskProfile(@Body() dto: UpdateRiskProfileDto, @CurrentUserId() userId: string) {
    const profile = await this.riskService.updateProfile(userId, dto);
    return toRiskProfileResponse(profile);
  }

  // ─── Risk violations ──────────────────────────────────────────────────────

  @Get('violations')
  @ApiOperation({
    summary: 'Get recent sanitized risk violations (rejected signals)',
    description:
      'Returns rejection code, reason, and timestamp only. Internal risk context, signal lineage, ' +
      'ownership IDs, balances, equity, and proposed order details are never exposed.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Max results (default 50)' })
  @ApiResponse({ status: 200, description: 'List of recent sanitized risk violations' })
  async getViolations(@CurrentUserId() userId: string, @Query('limit') limit?: string) {
    const take = limit ? Math.min(parseInt(limit, 10), 200) : 50;
    const violations = await this.riskService.getViolations(userId, take);
    return violations.map(toRiskViolationSummary);
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  @Get('status')
  @ApiOperation({
    summary: 'Get risk engine status summary',
    description: 'Quick view of kill switch, broker connection, and key risk limits',
  })
  @ApiResponse({ status: 200, description: 'Risk status summary' })
  async getRiskStatus(@CurrentUserId() userId: string) {
    const [profile, hasBroker, killSwitchActive] = await Promise.all([
      this.riskService.getOrCreateProfile(userId),
      this.riskService.hasBrokerConnection(userId),
      this.riskService.isKillSwitchActive(userId),
    ]);

    return {
      killSwitchActive,
      brokerConnected: hasBroker,
      canTrade: !killSwitchActive && hasBroker,
      limits: {
        maxDailyLossPercent: profile.maxDailyLossPercent,
        maxDrawdownPercent: profile.maxDrawdownPercent,
        maxOpenTrades: profile.maxOpenTrades,
        maxPositionSizeLot: profile.maxPositionSizeLot,
        allowedInstruments: profile.allowedInstruments ?? 'ALL',
        maxVolatilityScore: profile.maxVolatilityScore,
      },
    };
  }
}
