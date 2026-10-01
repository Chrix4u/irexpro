import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

export const TRADINGVIEW_VERIFIED_CLIENT_IP_HEADER = 'x-irexpro-verified-client-ip';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** TradingView's currently published webhook source addresses. */
export const TRADINGVIEW_WEBHOOK_SOURCE_IPS = new Set([
  '52.89.214.238',
  '34.212.75.30',
  '54.218.53.128',
  '52.32.178.7',
]);

/**
 * Trust boundary for TradingView webhooks.
 *
 * Nginx exposes this route only to Cloudflare origin traffic and overwrites
 * X-Irexpro-Verified-Client-IP with Cloudflare's CF-Connecting-IP value. The
 * Nest listener must therefore see the immediate peer as loopback, and the
 * verified client address must be one of TradingView's published webhook IPs.
 * A public caller hitting port 3010 directly cannot satisfy the loopback peer
 * requirement, and a caller through Nginx cannot choose the verified header.
 */
@Injectable()
export class TradingViewWebhookGuard implements CanActivate {
  private readonly logger = new Logger(TradingViewWebhookGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.configService.get<boolean>('tradingViewWebhook.enabled', false)) {
      throw new UnauthorizedException('TradingView webhook intake is disabled');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const peer = request.socket?.remoteAddress ?? '';
    if (!LOOPBACK.has(peer)) {
      this.logger.warn(`TradingView webhook rejected from non-proxy peer ${peer || 'unknown'}`);
      throw new UnauthorizedException('Untrusted TradingView webhook transport');
    }

    const raw = request.headers[TRADINGVIEW_VERIFIED_CLIENT_IP_HEADER];
    const verifiedIp = Array.isArray(raw) ? raw[0] : raw;
    if (!verifiedIp || !TRADINGVIEW_WEBHOOK_SOURCE_IPS.has(verifiedIp)) {
      this.logger.warn(
        `TradingView webhook rejected: source ${verifiedIp ?? 'missing'} is not allowlisted`,
      );
      throw new UnauthorizedException('Unverified TradingView webhook source');
    }

    return true;
  }
}
