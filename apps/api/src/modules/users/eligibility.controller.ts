import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AcceptEligibilityDisclosuresDto } from './dto/accept-eligibility-disclosures.dto';
import { ReviewUserEligibilityDto } from './dto/review-user-eligibility.dto';
import { ReviewUserKycDto } from './dto/review-user-kyc.dto';
import { EligibilityService } from './eligibility.service';
import { RoleName } from './entities/role.entity';

/**
 * Eligibility, disclosure, age, and KYC readiness controls.
 *
 * These endpoints record compliance evidence only. They do not expose broker
 * credentials, risk overrides, order submission, strategy logic, or execution methods.
 */
@ApiTags('Eligibility')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller()
export class EligibilityController {
  constructor(private readonly eligibilityService: EligibilityService) {}

  @Get('users/me/eligibility')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get current eligibility, age/KYC, disclosure, and consent status' })
  getMyEligibility(@CurrentUserId() userId: string) {
    return this.eligibilityService.getStatus(userId);
  }

  @Post('users/me/eligibility/disclosures')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Accept exact current disclosure versions with immutable evidence' })
  acceptDisclosures(@CurrentUserId() userId: string, @Body() dto: AcceptEligibilityDisclosuresDto) {
    return this.eligibilityService.acceptDisclosures(userId, dto);
  }

  @Post('users/me/eligibility/kyc-submission')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'Submit the current adult identity profile for administrator KYC review',
  })
  submitKyc(@CurrentUserId() userId: string) {
    return this.eligibilityService.submitKyc(userId);
  }

  @Get('admin/eligibility/reviews')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: '[Admin] List users requiring jurisdiction review' })
  listReviews() {
    return this.eligibilityService.listReviewQueue();
  }

  @Post('admin/eligibility/users/:id/review')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: '[Admin] Append an immutable jurisdiction review decision' })
  reviewUser(
    @Param('id', ParseUUIDPipe) userId: string,
    @CurrentUserId() reviewerUserId: string,
    @Body() dto: ReviewUserEligibilityDto,
  ) {
    return this.eligibilityService.reviewUser(userId, reviewerUserId, dto);
  }

  @Get('admin/identity/kyc/reviews')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: '[Admin] List adult users awaiting KYC review' })
  listKycReviews() {
    return this.eligibilityService.listKycReviewQueue();
  }

  @Post('admin/identity/users/:id/kyc-review')
  @UseGuards(RolesGuard)
  @Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: '[Admin] Append an immutable KYC review decision' })
  reviewKyc(
    @Param('id', ParseUUIDPipe) userId: string,
    @CurrentUserId() reviewerUserId: string,
    @Body() dto: ReviewUserKycDto,
  ) {
    return this.eligibilityService.reviewKyc(userId, reviewerUserId, dto);
  }
}
