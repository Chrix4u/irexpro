import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import { CurrentUserId } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { HostedMt5Service } from './hosted-mt5.service';

class HostedMt5WorkerLeaseDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/)
  workerId!: string;
}

class HostedMt5WorkerPresenceDto extends HostedMt5WorkerLeaseDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/)
  workerVersion!: string;

  @IsBoolean()
  runtimeReady!: boolean;

  @IsInt()
  @Min(1)
  @Max(256)
  maxSessions!: number;

  @IsInt()
  @Min(0)
  @Max(256)
  activeSessions!: number;
}

class HostedMt5WorkerHeartbeatDto extends HostedMt5WorkerLeaseDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Z0-9][A-Z0-9_:-]{0,63}$/)
  errorCode?: string;
}

@ApiTags('Hosted MetaTrader 5')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('broker/direct-mt5/hosted')
export class HostedMt5Controller {
  constructor(private readonly hostedService: HostedMt5Service) {}

  @Post(':brokerConnectionId/provision')
  @ApiOperation({ summary: 'Provision an owned DEMO MT5 connection on iRexPro infrastructure' })
  provision(
    @CurrentUserId() userId: string,
    @Param('brokerConnectionId') brokerConnectionId: string,
  ) {
    return this.hostedService.provision(userId, brokerConnectionId);
  }
}

@ApiTags('Hosted MetaTrader 5 Worker')
@Controller('broker/direct-mt5/hosted-worker')
export class HostedMt5WorkerController {
  constructor(private readonly hostedService: HostedMt5Service) {}

  @Public()
  @Post('presence')
  @ApiOperation({ summary: 'Report non-secret hosted MT5 worker readiness and capacity' })
  presence(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: HostedMt5WorkerPresenceDto,
  ) {
    return this.hostedService.heartbeatWorkerPresence(
      body.workerId,
      this.bearerToken(authorization),
      {
        workerVersion: body.workerVersion,
        runtimeReady: body.runtimeReady,
        maxSessions: body.maxSessions,
        activeSessions: body.activeSessions,
      },
    );
  }

  @Public()
  @Post('assignments/lease')
  @ApiOperation({ summary: 'Lease one hosted MT5 assignment to an iRexPro execution worker' })
  async lease(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: HostedMt5WorkerLeaseDto,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const assignment = await this.hostedService.leaseAssignment(
      body.workerId,
      this.bearerToken(authorization),
    );
    if (!assignment) {
      response?.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return assignment;
  }

  @Public()
  @Post('assignments/:connectorId/heartbeat')
  @ApiOperation({ summary: 'Renew an exact hosted MT5 worker assignment lease' })
  heartbeat(
    @Param('connectorId') connectorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: HostedMt5WorkerHeartbeatDto,
  ) {
    return this.hostedService.heartbeatAssignment(
      connectorId,
      body.workerId,
      this.bearerToken(authorization),
      body.errorCode ?? null,
    );
  }

  private bearerToken(authorization: string | undefined): string {
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) throw new UnauthorizedException('Hosted MT5 worker authentication failed');
    return match[1];
  }
}
