import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';
import { RoleName } from '../users/entities/role.entity';
import { ExecutionControlService } from './execution-control.service';
import { ActivateExecutionControlDto } from './dto/activate-execution-control.dto';

/**
 * ExecutionControlController — emergency control plane API (Directive §28).
 *
 * Access rules:
 * - GET  /status   — ADMIN / SUPER_ADMIN only (full control inventory)
 * - POST /activate — ADMIN / SUPER_ADMIN only (audited, CRITICAL severity)
 * - DELETE /:id    — ADMIN / SUPER_ADMIN only (audited)
 *
 * Users never read the global control inventory directly; execution denial
 * surfaces through the risk pipeline's structured rejection codes.
 */
@ApiTags('Execution Control')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
@Controller('execution-control')
export class ExecutionControlController {
  constructor(private readonly controlService: ExecutionControlService) {}

  @Get('status')
  @ApiOperation({ summary: 'List active emergency controls (admin only)' })
  @ApiResponse({ status: 200, description: 'Active execution controls' })
  async listControls(): Promise<unknown> {
    return this.controlService.listActiveControls();
  }

  @Post('activate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Activate an emergency execution control (admin only)',
    description:
      'Presence of a control disables execution at its scope. ' +
      'GLOBAL blocks all execution platform-wide; PROVIDER/USER/BROKER_CONNECTION ' +
      'block that specific entity. Fail-closed: an unreadable control store blocks everything.',
  })
  @ApiResponse({ status: 201, description: 'Control activated' })
  @ApiResponse({ status: 409, description: 'Control already active at this scope' })
  async activateControl(
    @Body() dto: ActivateExecutionControlDto,
    @CurrentUserId() adminUserId: string,
    @Request() req: { ip?: string },
  ) {
    return this.controlService.activateControl(dto, adminUserId, req.ip);
  }

  @Delete(':controlId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deactivate (clear) an emergency control (admin only)' })
  @ApiParam({ name: 'controlId', description: 'Execution control UUID' })
  @ApiResponse({ status: 204, description: 'Control deactivated' })
  async deactivateControl(
    @Param('controlId', ParseUUIDPipe) controlId: string,
    @CurrentUserId() adminUserId: string,
    @Request() req: { ip?: string },
  ): Promise<void> {
    await this.controlService.deactivateControl(controlId, adminUserId, req.ip);
  }
}
