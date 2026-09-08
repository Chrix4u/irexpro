import { readFileSync } from 'fs';
import { join } from 'path';
import type { ServerOptions } from 'socket.io';
import {
  createRealtimeSocketOptions,
  REALTIME_MAX_INBOUND_MESSAGE_BYTES,
} from './realtime-io.adapter';

describe('RealtimeIoAdapter transport policy', () => {
  const corsOrigins = ['https://irexpro.example', 'https://admin.irexpro.example'];

  it('passes the canonical configured origins and central inbound-size ceiling to Socket.IO', () => {
    const options = createRealtimeSocketOptions(corsOrigins);

    expect(options.cors).toEqual({
      origin: corsOrigins,
      credentials: true,
    });
    expect(options.cors).not.toEqual(expect.objectContaining({ origin: '*' }));
    expect(options.maxHttpBufferSize).toBe(REALTIME_MAX_INBOUND_MESSAGE_BYTES);
  });

  it('preserves gateway transport options while central security policy wins', () => {
    const gatewayOptions: Partial<ServerOptions> = {
      transports: ['websocket', 'polling'],
      maxHttpBufferSize: REALTIME_MAX_INBOUND_MESSAGE_BYTES * 4,
      cors: {
        origin: '*',
        credentials: false,
      },
    };

    const options = createRealtimeSocketOptions(corsOrigins, gatewayOptions);

    expect(options.transports).toEqual(['websocket', 'polling']);
    expect(options.maxHttpBufferSize).toBe(REALTIME_MAX_INBOUND_MESSAGE_BYTES);
    expect(options.cors).toEqual({
      origin: corsOrigins,
      credentials: true,
    });
  });

  it('preserves a deliberately smaller inbound-message ceiling', () => {
    const smallerLimit = 16 * 1024;
    const options = createRealtimeSocketOptions(corsOrigins, {
      maxHttpBufferSize: smallerLimit,
    });

    expect(options.maxHttpBufferSize).toBe(smallerLimit);
  });

  it('clamps an attempted larger inbound-message ceiling', () => {
    const options = createRealtimeSocketOptions(corsOrigins, {
      maxHttpBufferSize: REALTIME_MAX_INBOUND_MESSAGE_BYTES + 1,
    });

    expect(options.maxHttpBufferSize).toBe(REALTIME_MAX_INBOUND_MESSAGE_BYTES);
  });

  it('falls back to the central ceiling for invalid non-positive values', () => {
    const options = createRealtimeSocketOptions(corsOrigins, {
      maxHttpBufferSize: 0,
    });

    expect(options.maxHttpBufferSize).toBe(REALTIME_MAX_INBOUND_MESSAGE_BYTES);
  });

  it('copies the origin list instead of exposing mutable configuration state', () => {
    const mutableOrigins = ['https://irexpro.example'];
    const options = createRealtimeSocketOptions(mutableOrigins);

    mutableOrigins.push('https://later.example');

    expect(options.cors).toEqual({
      origin: ['https://irexpro.example'],
      credentials: true,
    });
  });

  it('keeps wildcard CORS out of the realtime gateway decorator', () => {
    const gatewaySource = readFileSync(
      join(__dirname, '../modules/realtime/realtime.gateway.ts'),
      'utf8',
    );

    expect(gatewaySource).not.toContain("origin: '*'");
    expect(gatewaySource).not.toMatch(/cors\s*:/u);
  });
});
