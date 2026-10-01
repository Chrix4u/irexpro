import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import {
  TradingViewWebhookGuard,
  TRADINGVIEW_VERIFIED_CLIENT_IP_HEADER,
} from './tradingview-webhook.guard';

const context = (peer: string, verifiedIp?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        socket: { remoteAddress: peer },
        headers: verifiedIp ? { [TRADINGVIEW_VERIFIED_CLIENT_IP_HEADER]: verifiedIp } : {},
      }),
    }),
  }) as any;

describe('TradingViewWebhookGuard', () => {
  const enabled = {
    get: jest.fn((key: string, fallback?: unknown) =>
      key === 'tradingViewWebhook.enabled' ? true : fallback,
    ),
  } as unknown as ConfigService;

  it('accepts an official TradingView IP only when delivered by the loopback reverse proxy', () => {
    const guard = new TradingViewWebhookGuard(enabled);
    expect(guard.canActivate(context('127.0.0.1', '52.89.214.238'))).toBe(true);
  });

  it('rejects a direct non-loopback peer even if it spoofs the verified header', () => {
    const guard = new TradingViewWebhookGuard(enabled);
    expect(() => guard.canActivate(context('163.245.212.15', '52.89.214.238'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a non-TradingView client IP', () => {
    const guard = new TradingViewWebhookGuard(enabled);
    expect(() => guard.canActivate(context('127.0.0.1', '203.0.113.10'))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when disabled', () => {
    const config = { get: jest.fn(() => false) } as unknown as ConfigService;
    const guard = new TradingViewWebhookGuard(config);
    expect(() => guard.canActivate(context('127.0.0.1', '52.89.214.238'))).toThrow(
      UnauthorizedException,
    );
  });
});
