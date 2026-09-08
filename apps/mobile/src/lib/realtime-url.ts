/**
 * Realtime connection URL derivation + reconnect backoff (pure functions).
 *
 * Sprint 51 PR-8 (Directive §E — mobile realtime architecture). Extracted
 * as pure functions so they are unit-testable without a React Native or
 * socket.io runtime (Directive §J).
 *
 * The mobile API base URL points at the public API root (e.g.
 * https://api.example.com or http://localhost:4000 — possibly with an
 * /api/v1 suffix). The realtime namespace lives on the API origin:
 *   http(s)://host[:port]/realtime  →  ws(s)://host[:port]/realtime
 */

/** Derive the Socket.IO realtime endpoint from the API base URL. */
export function deriveRealtimeUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("EXPO_PUBLIC_API_BASE_URL is not set");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid EXPO_PUBLIC_API_BASE_URL: ${trimmed}`);
  }
  // The /api/v1 suffix (if present) is a REST route prefix, not the socket
  // origin — strip path segments so the socket connects to the API origin.
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const portPart = url.port ? `:${url.port}` : "";
  return `${wsProtocol}//${url.hostname}${portPart}/realtime`;
}

/**
 * Exponential backoff step for reconnect attempts (Directive §E: robust
 * reconnect/backoff). Capped so mobile radios are not hammered.
 *
 * @param attempt 0-based reconnect attempt number
 * @returns delay in milliseconds
 */
export function reconnectDelayMs(
  attempt: number,
  baseMs = 1000,
  capMs = 30000,
): number {
  const safeAttempt = Math.max(Math.trunc(attempt), 0);
  const exponential = baseMs * Math.pow(2, safeAttempt);
  const jitter = Math.random() * 0.3 * exponential;
  return Math.min(Math.trunc(exponential + jitter), capMs);
}

/**
 * Stale-state detection threshold (Directive §E: "Do not assume a mobile
 * client remains permanently connected"). Screens may render a stale hint
 * when no event/heartbeat has been observed within this window.
 */
export const REALTIME_STALE_THRESHOLD_MS = 60_000;

/** True when the last event timestamp is older than the stale threshold. */
export function isStale(lastEventAt: number | null, now = Date.now()): boolean {
  if (lastEventAt === null) return true;
  return now - lastEventAt > REALTIME_STALE_THRESHOLD_MS;
}
