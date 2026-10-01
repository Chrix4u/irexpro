import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { TradingViewWebhookGuard } from '../../common/guards/tradingview-webhook.guard';
import { TradingViewWebhookSignalDto } from './dto/tradingview-webhook-signal.dto';
import { TradingViewWebhookService } from './tradingview-webhook.service';

@ApiTags('AI External Providers')
@Controller('ai/external/tradingview')
export class TradingViewWebhookController {
  constructor(private readonly service: TradingViewWebhookService) {}

  @Post()
  @Public()
  @UseGuards(TradingViewWebhookGuard)
  @ApiOperation({
    summary: '[TRADINGVIEW] Receive a source-verified PAPER-only webhook signal',
    description:
      'Network-edge authenticated TradingView webhook. User/session/broker identity are server-side bindings; the webhook carries no credentials and cannot obtain DEMO/LIVE authority.',
  })
  receive(@Body() dto: TradingViewWebhookSignalDto) {
    return this.service.receive(dto);
  }
}
