import { Body, Controller, HttpStatus, Post, SerializeOptions, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BrokerOAuthService } from './services/broker-oauth.service';
import {
  CompleteBrokerOAuthDto,
  ExchangeBrokerOAuthHandoffDto,
  LinkBrokerOAuthDto,
  StartBrokerOAuthDto,
} from './dto/broker-oauth.dto';
import { BrokerConnectionResponseDto } from './dto/broker-connection-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUserId } from '../../common/decorators/current-user.decorator';

/**
 * BrokerOAuthController — the user-facing cTrader OAuth connection flow
 * (Sprint 56 correction round 1 / audit point 6; round 2 / architect findings
 * 2 + 4).
 *
 * Routes (all authenticated; flow correlation is server-side, single-use,
 * and user-bound — see BrokerOAuthService):
 *   POST /broker/connections/oauth/authorize → consent URL + flowId
 *   POST /broker/connections/oauth/complete  → discovered cTID accounts (web)
 *   POST /broker/connections/oauth/handoff   → discovered cTID accounts
 *                                               (mobile: one-time handoff
 *                                               token exchange)
 *   POST /broker/connections/oauth/link      → BrokerConnection (encrypted)
 *
 * SECURITY: no endpoint accepts or returns application credentials or OAuth
 * token material. The mobile boundary (finding 4) routes the provider
 * authorization code to the UNAUTHENTICATED server callback
 * (broker-oauth-callback.controller.ts) which exchanges it server-side; the
 * mobile app only ever receives the opaque one-time handoff token.
 */
@ApiTags('broker-oauth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('broker/connections/oauth')
export class BrokerOAuthController {
  constructor(private readonly oauthService: BrokerOAuthService) {}

  @Post('authorize')
  @ApiOperation({
    summary: 'Start the cTrader OAuth authorization flow',
    description:
      'Creates a server-side single-use OAuth flow bound to the current user and ' +
      'returns the official id.ctrader.com consent URL. The client redirects the ' +
      'user to that URL in an EXTERNAL browser (the platform never sees cTrader ' +
      'passwords). Requires the platform cTrader Open API application credentials ' +
      'to be configured (fails closed with an honest message otherwise).',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Consent URL + server-side flow correlation id',
    type: Object,
  })
  @ApiResponse({
    status: 400,
    description: 'Broker not cTrader-family / platform app unconfigured',
  })
  async startAuthorization(
    @Body() dto: StartBrokerOAuthDto,
    @CurrentUserId() userId: string,
  ): Promise<{ authorizationUrl: string; flowId: string; expiresAt: string }> {
    return this.oauthService.startAuthorization(
      userId,
      dto.brokerId,
      undefined,
      dto.redirectUri,
      dto.channel ?? 'web',
    );
  }

  @Post('complete')
  @ApiOperation({
    summary: 'Exchange the authorization code and discover cTID accounts (web)',
    description:
      'Validates the server-side flow (owner, single-use, TTL), exchanges the ' +
      'single-use authorization code with the PLATFORM application credentials, and ' +
      'returns every trading account granted to the token (isLive flags included). ' +
      'The response carries NO token material — tokens are held server-side in the ' +
      'shared flow store, AES-256-GCM-encrypted at rest with a bounded TTL, until ' +
      'an account is linked.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Discovered cTID accounts (sanitized)',
    type: Object,
  })
  @ApiResponse({ status: 400, description: 'Code rejected (single-use / expired)' })
  @ApiResponse({ status: 404, description: 'Flow unknown or not owned by the caller' })
  @ApiResponse({ status: 409, description: 'Flow consumed or expired' })
  async completeAuthorization(
    @Body() dto: CompleteBrokerOAuthDto,
    @CurrentUserId() userId: string,
  ): Promise<{ flowId: string; accounts: unknown[] }> {
    return this.oauthService.completeAuthorization(userId, dto.flowId, dto.code);
  }

  @Post('handoff')
  @ApiOperation({
    summary: 'Exchange the one-time mobile OAuth handoff token (finding 4)',
    description:
      'Exchanges the opaque, user-bound, single-use, 120-second handoff token ' +
      '(delivered to the app via the controlled deep link after the SERVER ' +
      'callback exchanged the provider code) for the flow id and the ' +
      'sanitized discovered accounts. The provider authorization code, ' +
      'provider tokens, and application credentials NEVER reach the mobile ' +
      'app. Replay, expiry, and cross-user use fail closed as not-found.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Flow id + discovered cTID accounts (sanitized — no tokens)',
    type: Object,
  })
  @ApiResponse({ status: 404, description: 'Handoff token unknown, expired, used, or not owned' })
  @ApiResponse({ status: 409, description: 'Concurrent handoff replay (single consumer wins)' })
  async exchangeHandoffToken(
    @Body() dto: ExchangeBrokerOAuthHandoffDto,
    @CurrentUserId() userId: string,
  ): Promise<{ flowId: string; accounts: unknown[] }> {
    return this.oauthService.exchangeHandoffToken(userId, dto.handoffToken);
  }

  @Post('link')
  @SerializeOptions({ strategy: 'excludeAll' })
  @ApiOperation({
    summary: 'Link a discovered cTID account as an encrypted broker connection',
    description:
      'Persists the chosen account through the canonical createConnection path: ' +
      'credentials (access token + refresh token + expiry tracking) are ' +
      "AES-256-GCM encrypted; the environment derives from the account's " +
      'server-reported isLive flag; LIVE linking for production-LIVE-unverified ' +
      'brokers fails closed exactly like the manual path. The OAuth flow is ' +
      'consumed (single-use).',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'The created broker connection (no credentials)',
    type: BrokerConnectionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Account not granted to this authorization' })
  @ApiResponse({
    status: 403,
    description: 'LIVE connection on an unverified broker (fail-closed)',
  })
  @ApiResponse({ status: 404, description: 'Flow unknown or not owned by the caller' })
  async linkAccount(
    @Body() dto: LinkBrokerOAuthDto,
    @CurrentUserId() userId: string,
  ): Promise<BrokerConnectionResponseDto> {
    const connection = await this.oauthService.linkAccount(
      userId,
      dto.flowId,
      dto.ctidTraderAccountId,
      dto.displayName,
    );
    return Object.assign(new BrokerConnectionResponseDto(), connection);
  }
}
