import { resolveWorkspaceBrokerId } from "./trader-broker-preference";
import type { TerminalBrokerView, TraderTerminalStatus } from "./trader-terminal-status";

const demo = { id: "demo", accountType: "DEMO", status: "CONNECTED" } as TerminalBrokerView;
const live = { id: "live", accountType: "LIVE", status: "CONNECTED" } as TerminalBrokerView;
const status = {
  brokers: [live, demo],
  sessionStateKnown: true,
  session: null,
  sessionBroker: null,
} as Pick<TraderTerminalStatus, "brokers" | "sessionStateKnown" | "session" | "sessionBroker">;

describe("trader workspace account preference", () => {
  it("restores the exact demo account despite live being first", () => {
    expect(resolveWorkspaceBrokerId(status, "demo")).toBe("demo");
  });

  it("preserves an explicit live selection but never implicitly defaults to live", () => {
    expect(resolveWorkspaceBrokerId(status, "live")).toBe("live");
    expect(resolveWorkspaceBrokerId(status, null)).toBe("demo");
    expect(resolveWorkspaceBrokerId({ ...status, brokers: [live] }, null)).toBe("");
  });

  it("requires a new choice if the preferred broker is no longer available", () => {
    expect(resolveWorkspaceBrokerId({ ...status, brokers: [live] }, "demo")).toBe("");
  });

  it("pins the active session account regardless of the saved preference", () => {
    expect(resolveWorkspaceBrokerId({ ...status, sessionBroker: live }, "demo")).toBe("live");
    expect(resolveWorkspaceBrokerId({ ...status, sessionBroker: demo }, "live")).toBe("demo");
  });

  it("does not fall back to another broker when the active session account is missing", () => {
    const session = { brokerConnectionId: "missing" } as NonNullable<TraderTerminalStatus["session"]>;
    expect(resolveWorkspaceBrokerId({ ...status, session }, "demo")).toBe("");
  });
});
