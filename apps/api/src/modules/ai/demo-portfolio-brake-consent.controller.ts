import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { DemoPortfolioBrakeConsentService } from './demo-portfolio-brake-consent.service';

/**
 * User-controlled, exact-owner Pepperstone USD DEMO pause consent.
 * Authentication is enforced by the application's global JWT guard.
 * No ability to modify LIVE/PAPER accounts or other risk protections.
 */
@ApiTags('AI DEMO Portfolio Safety')
@Controller('ai/external/vps-forex/m1-tactical/portfolio-loss-pause')
export class DemoPortfolioBrakeConsentController {
  constructor(private readonly service: DemoPortfolioBrakeConsentService) {}

  @Get()
  @ApiOperation({
    summary: 'Explain the exact user account portfolio loss-streak pause',
    description:
      'Read current verified DEMO pause, signed last three broker results, ' +
      'expiry, and owner consent. No broker tokens or credentials exposed.',
  })
  getStatus(@CurrentUserId() userId: string) {
    return this.service.getStatus(userId);
  }

  @Post('decision')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Explicit owner decision for this exact loss-streak incident',
    description:
      'Authenticated verified owner only. RESUME requires an affirmative risk acknowledgement ' +
      'and matching current incident timestamp. Other financial gates remain authoritative.',
  })
  decide(
    @CurrentUserId() userId: string,
    @Body()
    body: {
      action: 'RESUME' | 'KEEP_PAUSED';
      acknowledged: boolean;
      incidentClosedAt: string;
    },
  ) {
    return this.service.decide(userId, body);
  }
}
