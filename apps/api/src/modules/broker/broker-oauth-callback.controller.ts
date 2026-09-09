import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { BrokerOAuthService } from './services/broker-oauth.service';
import { Public } from '../../common/decorators/public.decorator';

/** Deep-link URI query params rendered into the redirect (opaque to the web). */
const DEEP_LINK_TOKEN_PARAM = 'token';
const DEEP_LINK_ERROR_PARAM = 'error';

/**
 * BrokerOAuthCallbackController — the UNAUTHENTICATED server-side cTrader
 * OAuth callback for MOBILE flows (Sprint 56 correction round 2 / architect
 * finding 4).
 *
 * BOUNDARY (replacing the former irexpro:// custom-scheme provider redirect):
 *   cTrader → REGISTERED HTTPS server callback (this route) → the server
 *   immediately consumes/exchanges the provider code (the code, provider
 *   tokens, and app secret NEVER reach the mobile app) → the server maintains
 *   the flow correlation (slot-redirect-URI → the single PENDING flow) → the
 *   server issues a short-lived opaque ONE-TIME handoff token → a controlled
 *   302 deep-link redirect opens the mobile app (…?token=…) → the mobile app
 *   POSTs the handoff token to /broker/connections/oauth/handoff → account
 *   selection continues.
 *
 * Routes (PUBLIC — Spotware redirects an anonymous browser here; the route
 * itself carries no user data and grants nothing without the provider code):
 *   GET /broker/connections/oauth/callback        (a bare-slot configuration)
 *   GET /broker/connections/oauth/callback/:slot  (the slot path variant,
 *   e.g. …/callback/m1 mirroring CTRADER_MOBILE_CALLBACK_URIS)
 *
 * RESPONSE CONTRACT:
 * - success → HTTP 302 to the configured deep link
 *   (CTRADER_MOBILE_DEEP_LINK, default irexpro://broker/oauth/handoff) with
 *   ?token=<handoffToken>;
 * - failure → HTTP 302 to the same deep link with ?error=<reason> (opaque,
 *   generic);
 * - ALWAYS plus a minimal text/html body containing a manual anchor to the
 *   deep link (browsers that cannot follow custom schemes display it). The
 *   HTML contains NO user data, NO accounts, NO provider code — only generic
 *   guidance text.
 */
@ApiTags('broker-oauth')
@Controller('broker/connections/oauth/callback')
export class BrokerOAuthCallbackController {
  constructor(
    private readonly oauthService: BrokerOAuthService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'cTrader OAuth server callback (mobile flows — bare slot)',
    description:
      'Unauthenticated provider redirect target for a bare mobile callback ' +
      'slot configuration. Resolves the flow by request path, exchanges the ' +
      'code SERVER-side, and redirects to the deep link with a one-time ' +
      'handoff token (or a generic error).',
  })
  async handleCallback(
    @Query('code') code: string | undefined,
    @Query('error') providerError: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await this.handle(res, res.req?.path ?? '', code, providerError);
  }

  @Get(':slot')
  @Public()
  @ApiOperation({
    summary: 'cTrader OAuth server callback (mobile flows — slot path variant)',
    description:
      'Unauthenticated provider redirect target for slotted mobile callback ' +
      'URIs (…/callback/m1 … /mN mirrored in CTRADER_MOBILE_CALLBACK_URIS). ' +
      'Resolves the flow by request path, exchanges the code SERVER-side, and ' +
      'redirects to the deep link with a one-time handoff token (or a generic ' +
      'error).',
  })
  async handleSlotCallback(
    @Query('code') code: string | undefined,
    @Query('error') providerError: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await this.handle(res, res.req?.path ?? '', code, providerError);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async handle(
    res: Response,
    requestPath: string,
    code: string | undefined,
    providerError: string | undefined,
  ): Promise<void> {
    // Spotware reports user denial/Errors via an `error` query param — render
    // a clean generic failure (no provider details, no data).
    if (providerError) {
      this.renderDeepLinkRedirect(res, { error: 'provider-error' }, 'failed');
      return;
    }

    const result = await this.oauthService.handleMobileCallback(requestPath, code);

    if (result.status === 'ok') {
      this.renderDeepLinkRedirect(res, { [DEEP_LINK_TOKEN_PARAM]: result.handoffToken }, 'ok');
      return;
    }
    this.renderDeepLinkRedirect(res, { [DEEP_LINK_ERROR_PARAM]: result.reason }, 'failed');
  }

  /**
   * Renders the 302 deep-link redirect (token or opaque error reason) plus a
   * minimal manual-anchor HTML body. NO user data, accounts, or provider
   * codes appear anywhere in the response.
   */
  private renderDeepLinkRedirect(
    res: Response,
    params: Record<string, string>,
    outcome: 'ok' | 'failed',
  ): void {
    const deepLinkBase =
      this.configService.get<string>('broker.ctraderMobileDeepLink') ||
      'irexpro://broker/oauth/handoff';
    const qs = new URLSearchParams(params).toString();
    const deepLink = qs.length > 0 ? `${deepLinkBase}?${qs}` : deepLinkBase;

    const anchorText =
      outcome === 'ok'
        ? 'Returning to the iRexPro app…'
        : 'Authorization failed — restart the connection in the app.';
    const anchorLabel = outcome === 'ok' ? 'Open iRexPro' : 'Return to iRexPro';

    res.status(302);
    res.setHeader('Location', deepLink);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('text/html');
    res.send(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>iRexPro</title></head><body style="font-family:system-ui,sans-serif;' +
        'text-align:center;padding-top:3rem;color:#1f2933">' +
        `<p>${anchorText}</p>` +
        `<p><a href="${deepLink}">${anchorLabel}</a></p>` +
        '</body></html>',
    );
  }
}
