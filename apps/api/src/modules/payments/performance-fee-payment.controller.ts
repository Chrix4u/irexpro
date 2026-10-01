import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedPrincipal } from '../../common/interfaces/authenticated-principal.interface';
import { RoleName } from '../users/entities/role.entity';
import { InvoiceStatus } from './entities/invoice.entity';
import { PerformanceFeePaymentService } from './services/performance-fee-payment.service';
import { InitiatePerformanceFeeCheckoutDto } from './dto/initiate-performance-fee-checkout.dto';

/**
 * PerformanceFeePaymentController (Sprint 14)
 *
 * User/admin-facing endpoints to pay an existing performance-fee invoice.
 *
 * Access rules:
 * - A normal user can list / view / pay ONLY their own performance-fee invoices.
 * - ADMIN / SUPER_ADMIN can list / view / pay any user's invoice.
 * - Cross-user access by a normal user is rejected with 403.
 *
 * SAFETY (enforced by the service):
 * - Never marks invoice / assessment PAID and never updates the high-water mark.
 * - A verified provider webhook remains the ONLY path to paid state.
 * - No secrets are ever returned.
 */
@ApiTags('Performance Fee Payments')
@ApiBearerAuth('access-token')
@Controller('performance-fees')
@UseGuards(RolesGuard)
export class PerformanceFeePaymentController {
  constructor(private readonly svc: PerformanceFeePaymentService) {}

  private isAdmin(principal: AuthenticatedPrincipal): boolean {
    return !!principal.roles?.some((r) => r === RoleName.ADMIN || r === RoleName.SUPER_ADMIN);
  }

  @Get('invoices')
  @ApiOperation({ summary: 'List performance-fee invoices (own, or any as admin)' })
  listInvoices(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query('userId') queryUserId?: string,
    @Query('status') status?: InvoiceStatus,
    @Query('limit') limit?: string,
  ) {
    const admin = this.isAdmin(principal);
    if (!admin && queryUserId && queryUserId !== principal.userId) {
      throw new ForbiddenException('You can only view your own performance-fee invoices');
    }
    const effectiveUserId = admin ? queryUserId : principal.userId;
    return this.svc.listUserPerformanceFeeInvoices(effectiveUserId, {
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('invoices/:invoiceId')
  @ApiOperation({ summary: 'View a single performance-fee invoice' })
  getInvoice(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.svc.getInvoiceView(invoiceId, principal.userId, this.isAdmin(principal));
  }

  @Post('invoices/:invoiceId/checkout')
  @ApiOperation({ summary: 'Initiate payment checkout for a performance-fee invoice' })
  initiateCheckout(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: InitiatePerformanceFeeCheckoutDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Request() req: { ip?: string },
  ) {
    return this.svc.initiatePerformanceFeeCheckout({
      invoiceId,
      requestingUserId: principal.userId,
      isAdmin: this.isAdmin(principal),
      options: { provider: dto.provider, countryCode: dto.countryCode, currency: dto.currency },
      ipAddress: req.ip,
    });
  }

  @Get('invoices/:invoiceId/payment-status')
  @ApiOperation({ summary: 'Get payment status for a performance-fee invoice' })
  getPaymentStatus(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Request() req: { ip?: string },
  ) {
    return this.svc.getPerformanceFeePaymentStatus(
      invoiceId,
      principal.userId,
      this.isAdmin(principal),
      req.ip,
    );
  }
}
