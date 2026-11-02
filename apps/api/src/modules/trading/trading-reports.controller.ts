import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import {
  ProfitProtectionExitQualityService,
  type ProfitProtectionExitQualityOutcome,
  type ProfitProtectionStrategyRoute,
} from './profit-protection-exit-quality.service';

interface ProfitProtectionExitQualityHttpQuery {
  brokerConnectionId?: string;
  from?: string;
  to?: string;
  instrument?: string;
  direction?: string;
  strategyRoute?: string;
  outcome?: string;
  smallProfitOnly?: string;
  page?: string;
  pageSize?: string;
}

const integerOrUndefined = (value?: string): number | undefined => {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
};

@ApiTags('Trading Reports')
@Controller('trading/reports')
export class TradingReportsController {
  constructor(
    private readonly profitProtectionExitQualityService: ProfitProtectionExitQualityService,
  ) {}

  @Get('profit-protection-exit-quality')
  @ApiOperation({
    summary: 'Read authenticated Profit Protection exit-quality research evidence',
  })
  getProfitProtectionExitQuality(
    @CurrentUserId() userId: string,
    @Query() query: ProfitProtectionExitQualityHttpQuery,
  ) {
    return this.profitProtectionExitQualityService.getReport(userId, {
      brokerConnectionId: query.brokerConnectionId,
      from: query.from,
      to: query.to,
      instrument: query.instrument,
      direction: query.direction as 'BUY' | 'SELL' | undefined,
      strategyRoute: query.strategyRoute as ProfitProtectionStrategyRoute | undefined,
      outcome: query.outcome as ProfitProtectionExitQualityOutcome | undefined,
      smallProfitOnly: query.smallProfitOnly === 'true',
      page: integerOrUndefined(query.page),
      pageSize: integerOrUndefined(query.pageSize),
    });
  }
}
