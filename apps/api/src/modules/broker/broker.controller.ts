import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  SerializeOptions,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BrokerService } from './broker.service';
import { ConnectBrokerDto } from './dto/connect-broker.dto';
import { BrokerConnectionResponseDto } from './dto/broker-connection-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';

/**
 * BrokerConnectionsController — REST endpoints for broker connection management.
 *
 * SECURITY RULES enforced in this controller:
 * 1. All endpoints require JWT authentication
 * 2. All response objects use @SerializeOptions({ strategy: 'excludeAll' })
 *    which ensures only @Expose() fields are returned — credentials never leak
 * 3. IP address forwarded for audit logging on sensitive operations
 *
 * See: docs/architecture/09-broker-integration-architecture.md
 */
@ApiTags('Broker Connections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('broker/connections')
export class BrokerController {
  private readonly logger = new Logger(BrokerController.name);

  constructor(private readonly brokerService: BrokerService) {}

  // ─── Supported brokers ────────────────────────────────────────────────────

  @Get('supported')
  @ApiOperation({ summary: 'List supported broker integrations' })
  @ApiResponse({ status: 200, description: 'List of supported brokers' })
  getSupportedBrokers() {
    return this.brokerService.getSupportedBrokers();
  }

  // ─── User connections CRUD ─────────────────────────────────────────────────

  @Get()
  @SerializeOptions({ strategy: 'excludeAll' })
  @ApiOperation({ summary: 'List current user broker connections' })
  @ApiResponse({ status: 200, type: [BrokerConnectionResponseDto] })
  async listConnections(@CurrentUserId() userId: string): Promise<BrokerConnectionResponseDto[]> {
    const connections = await this.brokerService.findConnectionsByUser(userId);
    return connections.map((c) => Object.assign(new BrokerConnectionResponseDto(), c));
  }

  @Get(':connectionId')
  @SerializeOptions({ strategy: 'excludeAll' })
  @ApiOperation({ summary: 'Get a specific broker connection' })
  @ApiParam({ name: 'connectionId', description: 'Broker connection UUID' })
  @ApiResponse({ status: 200, type: BrokerConnectionResponseDto })
  async getConnection(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUserId() userId: string,
  ): Promise<BrokerConnectionResponseDto> {
    const connection = await this.brokerService.findConnectionById(connectionId, userId);
    return Object.assign(new BrokerConnectionResponseDto(), connection);
  }

  // ─── Create / Test ─────────────────────────────────────────────────────────

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test broker credentials without saving',
    description:
      'Validates API key/secret against the broker API. ' +
      'Credentials are NOT persisted. Required before creating a connection.',
  })
  @ApiResponse({ status: 200, description: 'Test result' })
  async testCredentials(@Body() dto: ConnectBrokerDto, @CurrentUserId() userId: string) {
    return this.brokerService.testCredentials(dto, userId);
  }

  @Post()
  @SerializeOptions({ strategy: 'excludeAll' })
  @ApiOperation({
    summary: 'Create a new broker connection (saves encrypted credentials)',
    description:
      'Credentials are encrypted with AES-256-GCM before storage. ' +
      'Raw credentials are never stored or returned.',
  })
  @ApiResponse({ status: 201, type: BrokerConnectionResponseDto })
  async createConnection(
    @Body() dto: ConnectBrokerDto,
    @CurrentUserId() userId: string,
  ): Promise<BrokerConnectionResponseDto> {
    const connection = await this.brokerService.createConnection(dto, userId);
    return Object.assign(new BrokerConnectionResponseDto(), connection);
  }

  // ─── Connect / Disconnect ──────────────────────────────────────────────────

  @Post(':connectionId/connect')
  @HttpCode(HttpStatus.OK)
  @SerializeOptions({ strategy: 'excludeAll' })
  @ApiOperation({
    summary: 'Establish live broker connection using stored credentials',
  })
  @ApiParam({ name: 'connectionId', description: 'Broker connection UUID' })
  @ApiResponse({ status: 200, type: BrokerConnectionResponseDto })
  async connectBroker(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUserId() userId: string,
  ): Promise<BrokerConnectionResponseDto> {
    const connection = await this.brokerService.connectBroker(connectionId, userId);
    return Object.assign(new BrokerConnectionResponseDto(), connection);
  }

  @Post(':connectionId/disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect a broker connection' })
  @ApiParam({ name: 'connectionId', description: 'Broker connection UUID' })
  @ApiResponse({ status: 204, description: 'Disconnected successfully' })
  async disconnectBroker(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.brokerService.disconnectBroker(connectionId, userId);
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  @Delete(':connectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete (soft-delete) a broker connection' })
  @ApiParam({ name: 'connectionId', description: 'Broker connection UUID' })
  @ApiResponse({ status: 204, description: 'Connection deleted' })
  async deleteConnection(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.brokerService.deleteConnection(connectionId, userId);
  }

  // ─── Live trading gate ─────────────────────────────────────────────────────

  @Post(':connectionId/enable-live-trading')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Enable LIVE trading for a connection (requires prior DEMO validation)',
    description:
      'DEMO mode must have been previously validated. ' +
      'LIVE and DEMO are separate connection records — never the same credentials. ' +
      'Advances the authorization state machine to ACTIVE (the only executable state).',
  })
  @ApiParam({ name: 'connectionId', description: 'Broker connection UUID' })
  @ApiResponse({ status: 204, description: 'Live trading enabled' })
  @ApiResponse({ status: 403, description: 'DEMO not yet validated / provider lacks LIVE support' })
  @ApiResponse({ status: 409, description: 'Authorization state cannot become ACTIVE' })
  async enableLiveTrading(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.brokerService.enableLiveTrading(connectionId, userId);
  }

  // ─── Authorization lifecycle (Sprint 50) ──────────────────────────────────

  @Post(':connectionId/revoke-authorization')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke automation authorization for a connection',
    description:
      'Transitions the authorization state machine to REVOKED and fail-closes ' +
      'live trading. Re-authorization requires the full path again.',
  })
  @ApiParam({ name: 'connectionId', description: 'Broker connection UUID' })
  @ApiResponse({ status: 204, description: 'Authorization revoked' })
  @ApiResponse({ status: 409, description: 'State cannot be revoked from current status' })
  async revokeAuthorization(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.brokerService.revokeAuthorization(connectionId, userId);
  }

  @Post(':connectionId/rotate-credentials')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Rotate stored credentials (validated before persisting)',
    description:
      'Validates the new credential set against the broker BEFORE replacing the ' +
      'stored ciphertext. On failure the old set is kept. Credentials are ' +
      'write-only and never returned.',
  })
  @ApiParam({ name: 'connectionId', description: 'Broker connection UUID' })
  @ApiResponse({ status: 204, description: 'Credentials rotated' })
  @ApiResponse({ status: 400, description: 'Validation failed — old credentials kept' })
  async rotateCredentials(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body() dto: ConnectBrokerDto,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.brokerService.rotateCredentials(connectionId, dto, userId);
  }
}
