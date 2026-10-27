import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
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
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUserId } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { DirectMt5CommandService } from './direct-mt5-command.service';
import { DirectMt5ConnectorBinding, DirectMt5PairingService } from './direct-mt5-pairing.service';
import { DirectMt5BridgeSessionManager } from '../adapters/metatrader-native/direct-mt5-bridge-session-manager.service';

class CreateDirectMt5PairingDto {
  @IsUUID()
  brokerConnectionId!: string;
}

class RedeemDirectMt5PairingDto {
  @IsString()
  @Length(10, 14)
  pairingCode!: string;

  @Matches(/^\d+$/)
  accountLogin!: string;

  @IsString()
  @Length(1, 255)
  brokerServer!: string;

  @IsString()
  @Length(1, 255)
  company!: string;

  @IsIn(['DEMO', 'LIVE'])
  environment!: 'DEMO' | 'LIVE';

  @IsOptional()
  @Matches(/^[A-Za-z]{3,8}$/)
  currency?: string | null;

  @IsInt()
  @Min(1)
  leverage!: number;

  @IsIn(['HEDGING', 'NETTING', 'EXCHANGE'])
  marginMode!: 'HEDGING' | 'NETTING' | 'EXCHANGE';

  @IsBoolean()
  terminalConnected!: boolean;

  @IsBoolean()
  terminalTradeAllowed!: boolean;

  @IsBoolean()
  accountTradeAllowed!: boolean;

  @IsBoolean()
  eaTradingAllowed!: boolean;

  @IsOptional()
  @IsBoolean()
  tradeAllowed?: boolean;
}

class DirectMt5ConnectorIdentityDto {
  @IsUUID()
  brokerConnectionId!: string;

  @Matches(/^\d+$/)
  accountLogin!: string;

  @IsString()
  @Length(1, 255)
  brokerServer!: string;
}

class DirectMt5HeartbeatDto extends DirectMt5ConnectorIdentityDto {
  @IsInt()
  @Min(1)
  sequence!: number;

  @IsString()
  @Length(1, 255)
  company!: string;

  @IsIn(['DEMO', 'LIVE'])
  environment!: 'DEMO' | 'LIVE';

  @Matches(/^[A-Za-z]{3,8}$/)
  currency!: string;

  @IsInt()
  @Min(1)
  leverage!: number;

  @IsIn(['HEDGING', 'NETTING', 'EXCHANGE'])
  marginMode!: 'HEDGING' | 'NETTING' | 'EXCHANGE';

  @IsBoolean()
  terminalConnected!: boolean;

  @IsBoolean()
  terminalTradeAllowed!: boolean;

  @IsBoolean()
  accountTradeAllowed!: boolean;

  @IsBoolean()
  eaTradingAllowed!: boolean;

  @IsOptional()
  @IsBoolean()
  tradingAllowed?: boolean;
}

class DirectMt5CommandResultDto extends DirectMt5ConnectorIdentityDto {
  @IsIn(['SUCCEEDED', 'FAILED', 'UNCERTAIN'])
  state!: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN';

  @IsOptional()
  @IsObject()
  result?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  error?: string | null;
}

@ApiTags('Direct MetaTrader 5')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('broker/direct-mt5')
export class DirectMt5PairingController {
  constructor(
    private readonly pairingService: DirectMt5PairingService,
    private readonly bridgeSessions: DirectMt5BridgeSessionManager,
  ) {}

  @Post('pairings')
  @ApiOperation({ summary: 'Generate a short-lived pairing code for a MetaTrader 5 connection' })
  createPairing(@CurrentUserId() userId: string, @Body() body: CreateDirectMt5PairingDto) {
    return this.pairingService.createPairing(userId, body.brokerConnectionId);
  }

  @Get('pairings/:brokerConnectionId/health')
  @ApiOperation({ summary: 'Read direct MT5 connector health for this broker connection' })
  health(@CurrentUserId() userId: string, @Param('brokerConnectionId') brokerConnectionId: string) {
    return this.pairingService.getConnectionHealth(userId, brokerConnectionId);
  }

  @Post('pairings/:brokerConnectionId/revoke')
  @ApiOperation({ summary: 'Revoke the direct MT5 connector bound to this broker connection' })
  async revoke(
    @CurrentUserId() userId: string,
    @Param('brokerConnectionId') brokerConnectionId: string,
  ) {
    const result = await this.pairingService.revokeConnector(userId, brokerConnectionId);
    this.bridgeSessions.detach(brokerConnectionId, result.connectorId);
    return result;
  }
}

@ApiTags('Direct MetaTrader 5 Connector')
@Controller('broker/direct-mt5/connectors')
export class DirectMt5ConnectorController {
  constructor(
    private readonly pairingService: DirectMt5PairingService,
    private readonly commandService: DirectMt5CommandService,
    private readonly bridgeSessions: DirectMt5BridgeSessionManager,
  ) {}

  @Public()
  @Post('redeem')
  @ApiOperation({ summary: 'Redeem a one-time MT5 pairing code from the local connector' })
  redeem(@Body() body: RedeemDirectMt5PairingDto) {
    const tradeAllowed =
      body.terminalConnected &&
      body.terminalTradeAllowed &&
      body.accountTradeAllowed &&
      body.eaTradingAllowed;
    return this.pairingService.redeemPairing(body.pairingCode, {
      accountLogin: body.accountLogin,
      brokerServer: body.brokerServer,
      company: body.company,
      environment: body.environment,
      currency: body.currency ?? null,
      leverage: body.leverage,
      marginMode: body.marginMode,
      terminalConnected: body.terminalConnected,
      terminalTradeAllowed: body.terminalTradeAllowed,
      accountTradeAllowed: body.accountTradeAllowed,
      eaTradingAllowed: body.eaTradingAllowed,
      tradeAllowed,
    });
  }

  @Public()
  @Post(':connectorId/heartbeat')
  async heartbeat(
    @Param('connectorId') connectorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: DirectMt5HeartbeatDto,
  ) {
    const token = this.bearerToken(authorization);
    const binding = await this.pairingService.authenticateConnector(connectorId, token);
    if (body.brokerConnectionId !== binding.brokerConnectionId) {
      throw new ConflictException('Connector identity does not match paired broker connection');
    }
    // recordHeartbeat owns account-login/server comparison so a terminal account
    // switch atomically SUSPENDS the connector instead of merely returning 409.
    const tradeAllowed =
      body.terminalConnected &&
      body.terminalTradeAllowed &&
      body.accountTradeAllowed &&
      body.eaTradingAllowed;
    const result = await this.pairingService.recordHeartbeat(binding, {
      accountLogin: body.accountLogin,
      brokerServer: body.brokerServer,
      sequence: body.sequence,
      tradeAllowed,
    });
    this.bridgeSessions.synchronize({
      connectorId,
      brokerConnectionId: body.brokerConnectionId,
      accountLogin: body.accountLogin,
      brokerServer: body.brokerServer,
      company: body.company,
      environment: body.environment,
      currency: body.currency,
      leverage: body.leverage,
      marginMode: body.marginMode,
      terminalConnected: body.terminalConnected,
      terminalTradeAllowed: body.terminalTradeAllowed,
      accountTradeAllowed: body.accountTradeAllowed,
      eaTradingAllowed: body.eaTradingAllowed,
      observedAt: new Date(),
    });
    return result;
  }

  @Public()
  @Post(':connectorId/commands/lease')
  async leaseNext(
    @Param('connectorId') connectorId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: DirectMt5ConnectorIdentityDto,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const command = await this.withBinding(connectorId, authorization, body, () =>
      this.commandService.leaseNext(connectorId),
    );
    if (!command) {
      response?.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return command;
  }

  @Public()
  @Post(':connectorId/commands/:commandId/result')
  @HttpCode(HttpStatus.OK)
  async recordResult(
    @Param('connectorId') connectorId: string,
    @Param('commandId') commandId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: DirectMt5CommandResultDto,
  ) {
    return this.withBinding(connectorId, authorization, body, () =>
      this.commandService.recordResult(connectorId, commandId, {
        state: body.state,
        result: body.result ?? null,
        error: body.error ?? null,
      }),
    );
  }

  private async withBinding<T>(
    connectorId: string,
    authorization: string | undefined,
    identity: DirectMt5ConnectorIdentityDto,
    action: (binding: DirectMt5ConnectorBinding) => Promise<T>,
  ): Promise<T> {
    const token = this.bearerToken(authorization);
    const binding = await this.pairingService.authenticateConnector(connectorId, token);
    if (
      identity.brokerConnectionId !== binding.brokerConnectionId ||
      identity.accountLogin !== binding.accountLogin ||
      identity.brokerServer !== binding.brokerServer
    ) {
      throw new ConflictException('Connector identity does not match paired MT5 account');
    }
    return action(binding);
  }

  private bearerToken(authorization: string | undefined): string {
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) {
      throw new UnauthorizedException('Connector authentication failed');
    }
    return match[1];
  }
}
