/**
 * Realtime URL derivation + backoff tests (Directive §E/§J).
 */
import {
  deriveRealtimeUrl,
  isStale,
  REALTIME_STALE_THRESHOLD_MS,
  reconnectDelayMs,
} from "../realtime-url";

describe("deriveRealtimeUrl", () => {
  it("maps https API roots to wss /realtime", () => {
    expect(deriveRealtimeUrl("https://api.example.com")).toBe(
      "wss://api.example.com/realtime",
    );
    expect(deriveRealtimeUrl("https://api.example.com/")).toBe(
      "wss://api.example.com/realtime",
    );
  });

  it("maps http to ws preserving ports", () => {
    expect(deriveRealtimeUrl("http://localhost:4000")).toBe(
      "ws://localhost:4000/realtime",
    );
  });

  it("strips REST route prefixes like /api/v1 (socket connects to the origin)", () => {
    expect(deriveRealtimeUrl("https://api.example.com/api/v1")).toBe(
      "wss://api.example.com/realtime",
    );
    expect(deriveRealtimeUrl("http://localhost:4000/api/v1")).toBe(
      "ws://localhost:4000/realtime",
    );
  });

  it("throws fail-closed on empty/blank input", () => {
    expect(() => deriveRealtimeUrl("")).toThrow();
    expect(() => deriveRealtimeUrl("   ")).toThrow();
  });

  it("throws on unparseable input", () => {
    expect(() => deriveRealtimeUrl("not a url")).toThrow();
  });

  it("rejects parseable non-HTTP(S) schemes instead of downgrading them to ws", () => {
    expect(() => deriveRealtimeUrl("ftp://api.example.com/api/v1")).toThrow(
      "must use http or https",
    );
    expect(() => deriveRealtimeUrl("file:///tmp/api")).toThrow(
      "must use http or https",
    );
  });

  it("rejects credential-bearing API base URLs", () => {
    expect(() =>
      deriveRealtimeUrl("https://user:password@api.example.com/api/v1"),
    ).toThrow("must not include credentials");
  });
});

describe("reconnectDelayMs (exponential, jittered, capped)", () => {
  it("never exceeds the cap", () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      expect(reconnectDelayMs(attempt, 1000, 30000)).toBeLessThanOrEqual(30000);
    }
  });

  it("grows with the attempt number", () => {
    const early = reconnectDelayMs(0, 1000, 30000);
    const late = reconnectDelayMs(8, 1000, 30000);
    expect(late).toBeGreaterThan(early);
  });

  it("clamps negative attempts to the first step", () => {
    expect(reconnectDelayMs(-3, 1000, 30000)).toBeGreaterThanOrEqual(1000);
    expect(reconnectDelayMs(-3, 1000, 30000)).toBeLessThanOrEqual(1300);
  });
});

describe("isStale (§E stale-state detection)", () => {
  it("null last event is stale", () => {
    expect(isStale(null)).toBe(true);
  });

  it("fresh events are not stale", () => {
    expect(isStale(Date.now())).toBe(false);
  });

  it("events older than the threshold are stale", () => {
    expect(isStale(Date.now() - REALTIME_STALE_THRESHOLD_MS - 1)).toBe(true);
    expect(isStale(Date.now() - REALTIME_STALE_THRESHOLD_MS + 5000)).toBe(
      false,
    );
  });
});
