/**
 * Realtime connection handshake logic tests (architect Phase I3,
 * Directive §J).
 *
 * RealtimeProvider itself needs the React Native runtime (AppState) — the
 * socket connection options builder is extracted as a pure function
 * (src/lib/realtime-socket-options.ts) so the security invariants of the
 * auth handshake are unit-testable in a plain node environment:
 *
 *   - token freshness: the CURRENT token is read on every invocation of the
 *     auth callback (socket.io evaluates it per connection attempt), so a
 *     refreshed/rotated token propagates to reconnects;
 *   - token placement: handshake auth payload only — never URL/query;
 *   - websocket transport only.
 */
import { buildSocketOptions } from "../../lib/realtime-socket-options";

describe("buildSocketOptions (Phase I3 — refreshed auth handshake)", () => {
  it("auth is a callback that yields the CURRENT token value on every invocation", () => {
    let currentToken: string | null = "token-A";
    const options = buildSocketOptions(() => currentToken);
    expect(typeof options.auth).toBe("function");

    // First connection attempt.
    const firstAck = jest.fn();
    options.auth(firstAck);
    expect(firstAck).toHaveBeenCalledTimes(1);
    expect(firstAck).toHaveBeenCalledWith({ token: "token-A" });

    // Token rotated by auth-context (refresh): the SAME options object
    // must yield the NEW value on the next connection attempt — proving
    // the stale-token-at-socket-creation defect is gone.
    currentToken = "token-B";
    const secondAck = jest.fn();
    options.auth(secondAck);
    expect(secondAck).toHaveBeenCalledTimes(1);
    expect(secondAck).toHaveBeenCalledWith({ token: "token-B" });
  });

  it("yields a null token when none is held (fail-closed, never fabricates)", () => {
    const options = buildSocketOptions(() => null);
    const ack = jest.fn();
    options.auth(ack);
    expect(ack).toHaveBeenCalledWith({ token: null });
  });

  it("keeps the token OUT of the URL/query — auth handshake payload only", () => {
    const options = buildSocketOptions(() => "token-A");
    // No query string / URL field may carry credentials.
    const optionKeys = Object.keys(options);
    expect(optionKeys).not.toContain("query");
    expect((options as unknown as Record<string, unknown>).query).toBeUndefined();
    expect((options as unknown as Record<string, unknown>).url).toBeUndefined();
    // The token value must not be baked into any serializable option (the
    // auth function itself serializes away — only the live callback reads
    // the token source).
    expect(JSON.stringify(options)).not.toContain("token-A");
  });

  it("uses websocket transport only (no polling upgrade path)", () => {
    const options = buildSocketOptions(() => "token-A");
    expect(options.transports).toEqual(["websocket"]);
    expect(options.transports).toHaveLength(1);
  });

  it("reconnects automatically with capped, jittered first-step backoff", () => {
    const options = buildSocketOptions(() => "token-A");
    expect(options.reconnection).toBe(true);
    expect(options.reconnectionDelay).toBeGreaterThanOrEqual(1000);
    expect(options.reconnectionDelay).toBeLessThanOrEqual(1300);
    expect(options.reconnectionDelayMax).toBe(30000);
  });
});
