import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Realtime client control messages are intentionally small. Keep a generous
 * ceiling for JWT handshakes and future metadata while preventing individual
 * Socket.IO packets from consuming the library's much larger default budget.
 */
export const REALTIME_MAX_INBOUND_MESSAGE_BYTES = 64 * 1024;

/**
 * Build Socket.IO server options from the same canonical browser-origin
 * allowlist used by Nest HTTP CORS. Adapter-owned CORS and inbound-size policy
 * always win over gateway-level options so a feature decorator cannot silently
 * reintroduce a wildcard browser policy or raise the packet-size ceiling.
 */
export function createRealtimeSocketOptions(
  corsOrigins: readonly string[],
  options: Partial<ServerOptions> = {},
): Partial<ServerOptions> {
  const requestedMaxHttpBufferSize = options.maxHttpBufferSize;
  const maxHttpBufferSize =
    typeof requestedMaxHttpBufferSize === 'number' &&
    Number.isFinite(requestedMaxHttpBufferSize) &&
    requestedMaxHttpBufferSize > 0
      ? Math.min(requestedMaxHttpBufferSize, REALTIME_MAX_INBOUND_MESSAGE_BYTES)
      : REALTIME_MAX_INBOUND_MESSAGE_BYTES;

  return {
    ...options,
    maxHttpBufferSize,
    cors: {
      origin: [...corsOrigins],
      credentials: true,
    },
  };
}

/**
 * Socket.IO adapter with one server-owned CORS and inbound-message policy.
 *
 * Socket.IO/CORS permits clients that do not send an Origin header, preserving
 * native/mobile compatibility, while browser requests with an Origin are
 * constrained to the canonical configured allowlist.
 */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly corsOrigins: readonly string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: Partial<ServerOptions>) {
    return super.createIOServer(port, createRealtimeSocketOptions(this.corsOrigins, options));
  }
}
