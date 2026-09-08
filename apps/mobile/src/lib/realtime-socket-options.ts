/**
 * Realtime Socket.IO connection options (pure builder, Directive §E/§J +
 * architect Phase I3).
 *
 * Extracted from RealtimeProvider so the security invariants of the auth
 * handshake are unit-testable without a React Native or socket.io runtime:
 *
 *   1. The access token is read on EVERY connection attempt (socket.io
 *      evaluates the FUNCTION form of `auth` per attempt — initial connect
 *      AND reconnects), so a refreshed/rotated token propagates instead of
 *      reconnects retrying the stale token captured at socket creation.
 *   2. The token rides ONLY the auth handshake payload
 *      (socket.handshake.auth.token — the same JWT class the HTTP client
 *      sends as a Bearer header). It never appears in the URL or query
 *      string (fail-closed: no credentials in query strings).
 *   3. websocket transport only — no polling upgrade path.
 */
import { reconnectDelayMs } from "./realtime-url";

/** Payload socket.io sends as `socket.handshake.auth` to the gateway. */
export interface RealtimeAuthPayload {
  token: string | null;
}

/** Ack callback socket.io passes to the `auth` function form. */
export type RealtimeAuthAck = (payload: RealtimeAuthPayload) => void;

export interface RealtimeSocketOptions {
  /** websocket only — never long-polling. */
  transports: ["websocket"];
  /**
   * Function form (Phase I3): evaluated on every connection attempt with a
   * fresh read of the token source, so refreshed tokens reach reconnects.
   */
  auth: (ack: RealtimeAuthAck) => void;
  reconnection: boolean;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
}

/**
 * Build the Socket.IO manager options for the /realtime namespace.
 *
 * @param getToken zero-arg getter for the CURRENT access token (the
 *                 in-memory token source owned by lib/api — never persisted
 *                 outside SecureStore).
 */
export function buildSocketOptions(
  getToken: () => string | null,
): RealtimeSocketOptions {
  return {
    transports: ["websocket"],
    auth: (ack) => ack({ token: getToken() }),
    reconnection: true,
    reconnectionDelay: reconnectDelayMs(0),
    reconnectionDelayMax: 30000,
  };
}
