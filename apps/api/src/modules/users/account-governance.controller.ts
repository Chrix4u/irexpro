import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RoleName } from './entities/role.entity';
import { AccountGovernanceService, PublicAppealResult } from './account-governance.service';
import { ListAccountAppealsQueryDto } from './dto/list-account-appeals-query.dto';
import { ResolveAccountAppealDto } from './dto/resolve-account-appeal.dto';
import { SubmitAccountAppealDto } from './dto/submit-account-appeal.dto';
import { UpdateAccountStatusDto } from './dto/update-account-status.dto';

/**
 * Account-access safety endpoints. They intentionally do not expose any
 * broker, payment, risk, or execution action.
 */
@ApiTags('Account Governance')
@Controller()
@UseGuards(JwtAuthGuard)
export class AccountGovernanceController {
  constructor(private readonly governanceService: AccountGovernanceService) {}

  @Post('account-appeals')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 15 * 60 * 1000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit an account-access appeal without account enumeration' })
  @ApiResponse({
    status: 200,
    description: 'Always returns the same generic response.',
  })
  async submitAppeal(
    @Body() dto: SubmitAccountAppealDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublicAppealResult> {
    return this.governanceService.submitAppeal(dto, { ipAddress, userAgent });
  }

  @Get('admin/account-appeals')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: '[Admin] List account-access appeals' })
  async listAppeals(@Query() query: ListAccountAppealsQueryDto) {
    return this.governanceService.listAppeals(query.status, query.page, query.limit);
  }

  @Post('admin/account-appeals/:id/resolve')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: '[Admin] Resolve an account-access appeal' })
  async resolveAppeal(
    @Param('id', ParseUUIDPipe) appealId: string,
    @CurrentUserId() reviewerUserId: string,
    @Body() dto: ResolveAccountAppealDto,
  ) {
    return this.governanceService.resolveAppeal(appealId, reviewerUserId, dto);
  }

  @Patch('admin/users/:id/account-status')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  @ApiBearerAuth('access-token')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: '[Admin] Deactivate, permanently lock, or soft-delete an account' })
  async updateAccountStatus(
    @Param('id', ParseUUIDPipe) userId: string,
    @CurrentUserId() actorUserId: string,
    @Body() dto: UpdateAccountStatusDto,
  ) {
    return this.governanceService.applyAdminAction(userId, actorUserId, dto);
  }
}
