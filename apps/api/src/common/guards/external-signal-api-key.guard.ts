import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'crypto';

export const EXTERNAL_SIGNAL_API_KEY_HEADER = 'x-irexpro-signal-provider-key';

/**
 * Protects the generic external-signal intake. This key belongs to a trusted
 * provider relay/integration service, never a browser and never a TradingView
 * alert body. The endpoint fails closed when disabled or unconfigured.
 */
@Injectable()
export class ExternalSignalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ExternalSignalApiKeyGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const enabled = this.configService.get<boolean>('externalSignals.enabled', false);
    if (!enabled) {
      this.logger.warn('External signal intake is disabled — BLOCKED');
      throw new UnauthorizedException('External signal intake is disabled');
    }

    const expectedKey = this.configService.get<string>('externalSignals.apiKey');
    if (!expectedKey) {
      this.logger.error('EXTERNAL_SIGNAL_PROVIDER_KEY is not configured — endpoint blocked');
      throw new UnauthorizedException('External signal provider key is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedKey = request.headers[EXTERNAL_SIGNAL_API_KEY_HEADER] as string | undefined;
    if (!providedKey) {
      throw new UnauthorizedException(`Missing required header: ${EXTERNAL_SIGNAL_API_KEY_HEADER}`);
    }

    const digest = (value: string) =>
      crypto.createHmac('sha256', 'irexpro-external-signal-key-compare').update(value).digest();
    if (!crypto.timingSafeEqual(digest(providedKey), digest(expectedKey))) {
      this.logger.warn('External signal endpoint called with invalid provider key — BLOCKED');
      throw new UnauthorizedException('Invalid external signal provider key');
    }
    return true;
  }
}
