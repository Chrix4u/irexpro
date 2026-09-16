import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import {
  ExecutionConfirmationResult,
  ExecutionConfirmationService,
  PendingExecutionConfirmationView,
} from './execution-confirmation.service';

/**
 * SEMI_AUTO confirmation endpoints (Sprint 56 correction round 5, task 50-c,
 * architect issue #298).
 *
 * Server authority ONLY: the frontend lists the authenticated user's PENDING
 * confirmations (full order detail) and requests confirmation — the
 * one-time consumption (confirmation + RiskGrant, CAS single-winner) happens
 * EXCLUSIVELY on the server through the FINAL DISPATCH BOUNDARY. The
 * frontend can never fabricate approval.
 *
 * POST confirm returns CONSUMED only on success; every drift (expired /
 * consumed / revoked / generation-mismatch / grant or session state) surfaces
 * the boundary's typed 409-style error verbatim.
 */
@ApiTags('Execution')
@Controller('execution/confirmations')
export class ExecutionConfirmationController {
  constructor(private readonly confirmationService: ExecutionConfirmationService) {}

  @Get('pending')
  @ApiOperation({
    summary: "List the authenticated user's PENDING SEMI_AUTO confirmations with full order detail",
  })
  @ApiResponse({ status: 200, type: Object, isArray: true })
  async listPending(
    @CurrentUserId() userId: string,
  ): Promise<{ confirmations: PendingExecutionConfirmationView[] }> {
    const confirmations = await this.confirmationService.listPending(userId);
    return { confirmations };
  }

  @Post(':id/confirm')
  @ApiOperation({
    summary:
      'Confirm ONE pending confirmation (server authority: one-time consumption + authorized dispatch)',
  })
  @ApiResponse({ status: 201, type: Object })
  async confirm(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) confirmationId: string,
  ): Promise<ExecutionConfirmationResult> {
    return this.confirmationService.confirm(userId, confirmationId);
  }
}
