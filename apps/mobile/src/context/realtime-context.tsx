/**
 * RealtimeProvider — mobile realtime layer (Directive §E, Sprint 51 PR-8).
 *
 * Connects to the SAME /realtime Socket.IO namespace the web consumes,
 * authenticating with the in-memory access token (never persisted outside
 * SecureStore). Handles reconnect/backoff, background/foreground lifecycle
 * (AppState), and stale-state detection.
 *
 * Event contract: the server-side RealtimeEvent enum (verified in
 * apps/api/src/modules/realtime/events/realtime-event.enum.ts). The mobile
 * client subscribes to the user room the way the gateway expects — the
 * server joins sockets to `user:{userId}` automatically after
 * 'authenticate' — and listens for the order lifecycle + reconciliation +
 * broker-connection events the backend actually emits:
 *
 *   order.submitted / order.acknowledged / order.filled / order.rejected
 *   order.reconciliation_pending
 *   reconciliation.discrepancy.detected / reconciliation.discrepancy.resolved
 *   broker.connection.status_changed / broker.connection.authorization_changed
 *   execution.control.changed
 *   trade.opened / trade.closed / trade.rejected
 *   system.notification
 *
 * No fabricated events: anything not in the server enum is never listened to.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import { io, type Socket } from "socket.io-client";
import { getAccessTokenValue } from "../lib/api";
import {
  deriveRealtimeUrl,
  isStale,
  reconnectDelayMs,
  REALTIME_STALE_THRESHOLD_MS,
} from "../lib/realtime-url";
import { buildSocketOptions } from "../lib/realtime-socket-options";

/**
 * The realtime event names the mobile app listens to — mirrored EXACTLY from
 * the server's RealtimeEvent enum values (no invention).
 */
export const REALTIME_EVENTS = [
  "order.submitted",
  "order.acknowledged",
  "order.filled",
  "order.rejected",
  "order.reconciliation_pending",
  "reconciliation.discrepancy.detected",
  "reconciliation.discrepancy.resolved",
  "broker.connection.status_changed",
  "broker.connection.authorization_changed",
  "execution.control.changed",
  "trade.opened",
  "trade.closed",
  "trade.rejected",
  "system.notification",
] as const;

export type RealtimeEventName = (typeof REALTIME_EVENTS)[number];
export type RealtimeEventHandler = (
  event: RealtimeEventName,
  payload: unknown,
) => void;

interface RealtimeState {
  connected: boolean;
  lastEventAt: number | null;
  lastError: string | null;
  stale: boolean;
}

interface RealtimeContextValue extends RealtimeState {
  /** Subscribe to the real server events. Returns an unsubscribe fn. */
  addListener(handler: RealtimeEventHandler): () => void;
  refresh(): void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RealtimeState>({
    connected: false,
    lastEventAt: null,
    lastError: null,
    stale: true,
  });
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef<Set<RealtimeEventHandler>>(new Set());
  const staleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleServerEvent = useCallback((eventName: RealtimeEventName) => {
    setState((prev) => ({ ...prev, lastEventAt: Date.now(), stale: false }));
    for (const handler of handlersRef.current) {
      try {
        handler(eventName, null);
      } catch {
        // A screen handler must never take down the realtime layer.
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;

    const connect = (): Socket | null => {
      if (disposed) return null;
      let url: string;
      try {
        url = deriveRealtimeUrl(process.env.EXPO_PUBLIC_API_BASE_URL ?? "");
      } catch (err) {
        setState((prev) => ({
          ...prev,
          lastError:
            err instanceof Error
              ? err.message
              : "realtime URL derivation failed",
        }));
        return null;
      }
      // Connection options come from the pure builder (Directive §J). The
      // auth payload uses socket.io's FUNCTION form (Phase I3): the CURRENT
      // access token is read on EVERY connection attempt, so a refreshed or
      // rotated token propagates to reconnects instead of retrying the
      // stale token captured at socket creation. The token rides the auth
      // handshake payload (socket.handshake.auth.token — the same JWT class
      // the HTTP client sends as a Bearer header), never the URL/query.
      // Fail-closed: only the authenticated API origin (deriveRealtimeUrl).
      const socket = io(url, buildSocketOptions(getAccessTokenValue));

      socket.on("connect", () => {
        attempt = 0;
        setState((prev) => ({ ...prev, connected: true, lastError: null }));
      });
      socket.on("disconnect", () => {
        setState((prev) => ({ ...prev, connected: false }));
      });
      socket.io.on("reconnect_attempt", () => {
        attempt += 1;
        socket.io.reconnectionDelay(reconnectDelayMs(attempt));
      });
      socket.on("connect_error", (err: Error) => {
        setState((prev) => ({
          ...prev,
          connected: false,
          lastError: err.message,
        }));
      });

      for (const eventName of REALTIME_EVENTS) {
        socket.on(eventName, () => handleServerEvent(eventName));
      }
      return socket;
    };

    socketRef.current = connect();

    // Foreground/background lifecycle (Directive §E: a mobile client is NOT
    // permanently connected — tear the socket down in background).
    const onAppStateChange = (next: AppStateStatus) => {
      if (next === "active") {
        if (!socketRef.current) socketRef.current = connect();
        else if (!socketRef.current.connected) socketRef.current.connect();
      } else if (socketRef.current) {
        socketRef.current.disconnect();
        setState((prev) => ({ ...prev, connected: false }));
      }
    };
    const appStateSub = AppState.addEventListener("change", onAppStateChange);

    // Stale-state detection ticker.
    const tick = () => {
      setState((prev) => ({ ...prev, stale: isStale(prev.lastEventAt) }));
    };
    staleTimerRef.current = setInterval(tick, REALTIME_STALE_THRESHOLD_MS / 2);

    return () => {
      // Teardown guarantee (Phase I3): App.tsx mounts RealtimeProvider ONLY
      // inside the authenticated branch — when the user becomes null
      // (logout, revoked session), the provider unmounts, this cleanup runs,
      // and the socket is disconnected. No realtime channel outlives the
      // authenticated session.
      disposed = true;
      appStateSub.remove();
      if (staleTimerRef.current) clearInterval(staleTimerRef.current);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [handleServerEvent]);

  const addListener = useCallback(
    (handler: RealtimeEventHandler): (() => void) => {
      handlersRef.current.add(handler);
      return () => {
        handlersRef.current.delete(handler);
      };
    },
    [],
  );

  const refresh = useCallback(() => {
    const socket = socketRef.current;
    if (socket && !socket.connected) socket.connect();
    setState((prev) => ({ ...prev, lastEventAt: Date.now() }));
  }, []);

  const value = useMemo<RealtimeContextValue>(
    () => ({ ...state, addListener, refresh }),
    [state, addListener, refresh],
  );

  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

/** Access the realtime layer. Throws if the provider is absent (fail-closed). */
export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error("useRealtime must be used within RealtimeProvider");
  }
  return ctx;
}
