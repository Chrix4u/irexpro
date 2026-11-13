import { DEFAULT_DEMO_CHART_INSTRUMENTS, resolveDemoChartInstruments } from "./trading-chart-focus";

describe("DEMO chart focus", () => {
  it("defaults to the operator-approved two pairs without exposing the legacy six", () => {
    expect(DEFAULT_DEMO_CHART_INSTRUMENTS).toEqual(["EURUSD", "AUDUSD"]);
    expect(Object.isFrozen(DEFAULT_DEMO_CHART_INSTRUMENTS)).toBe(true);
    expect(resolveDemoChartInstruments(null)).toEqual(["EURUSD", "AUDUSD"]);
    expect(resolveDemoChartInstruments({ authorityMode: "PAPER_RESEARCH" })).toEqual(["EURUSD", "AUDUSD"]);
  });

  it("uses the authenticated DEMO entry universe and drops duplicated or malformed symbols", () => {
    expect(resolveDemoChartInstruments({
      authorityMode: "DEMO_FULL_AUTO",
      demoEntryInstruments: ["EURUSD", "AUDUSD", "USDCHF", "AUDUSD", "XAUUSD", "EURUSDx"],
    })).toEqual(["EURUSD", "AUDUSD", "USDCHF"]);
  });

  it("does not re-enable paused pairs when a tactical-status request is unavailable", () => {
    expect(resolveDemoChartInstruments({
      authorityMode: "DEMO_FULL_AUTO",
      demoEntryInstruments: [],
    })).toEqual(["EURUSD", "AUDUSD"]);
  });

  it("can reflect an explicitly restored broker DEMO entry universe in the future", () => {
    expect(resolveDemoChartInstruments({
      authorityMode: "DEMO_FULL_AUTO",
      demoEntryInstruments: ["AUDUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF"],
    })).toHaveLength(6);
  });
});
