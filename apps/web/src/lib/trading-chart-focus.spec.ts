import { DEFAULT_DEMO_CHART_INSTRUMENTS, resolveDemoChartInstruments, nextAiFocusedChartInstrument, isResearchOnlyAiFocus } from "./trading-chart-focus";

describe("DEMO chart focus", () => {
  it("defaults to the four approved DEMO pairs while status is refreshing", () => {
    expect(DEFAULT_DEMO_CHART_INSTRUMENTS).toEqual(["EURUSD", "AUDUSD", "USDCAD", "USDJPY"]);
    expect(Object.isFrozen(DEFAULT_DEMO_CHART_INSTRUMENTS)).toBe(true);
    expect(resolveDemoChartInstruments(null)).toEqual(["EURUSD", "AUDUSD", "USDCAD", "USDJPY"]);
    expect(resolveDemoChartInstruments({ authorityMode: "PAPER_RESEARCH" })).toEqual(["EURUSD", "AUDUSD", "USDCAD", "USDJPY"]);
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
    })).toEqual(["EURUSD", "AUDUSD", "USDCAD", "USDJPY"]);
  });

  it("can reflect an explicitly restored broker DEMO entry universe in the future", () => {
    expect(resolveDemoChartInstruments({
      authorityMode: "DEMO_FULL_AUTO",
      demoEntryInstruments: ["AUDUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF"],
    })).toHaveLength(6);
  });
});

describe("AI instrument auto-follow", () => {
  const watched = ["EURUSD", "USDJPY", "USDCAD"];
  it("switches the chart when a newly focused executable pair changes", () => {
    expect(nextAiFocusedChartInstrument({ aiFocus: "USDCAD", previousAiFocus: "EURUSD", watchedInstruments: watched }))
      .toBe("USDCAD");
    expect(nextAiFocusedChartInstrument({ aiFocus: "USDJPY", previousAiFocus: "USDCAD", watchedInstruments: watched }))
      .toBe("USDJPY");
  });
  it("does not undo a manual chart selection while AI focus is unchanged", () => {
    expect(nextAiFocusedChartInstrument({ aiFocus: "USDCAD", previousAiFocus: "USDCAD", watchedInstruments: watched }))
      .toBeNull();
  });
  it("ignores absent, unsupported and research-only focused instruments", () => {
    for (const aiFocus of [null, "", "XAUUSD", "AUDUSD"]) {
      expect(nextAiFocusedChartInstrument({ aiFocus, previousAiFocus: "USDCAD", watchedInstruments: watched }))
        .toBeNull();
    }
  });
});

describe("research versus executable focus presentation", () => {
  const four=["EURUSD","AUDUSD","USDCAD","USDJPY"];
  it("marks GBPUSD as research only without chart switching",()=>{
    expect(isResearchOnlyAiFocus({aiFocus:"GBPUSD",watchedInstruments:four})).toBe(true);
    expect(nextAiFocusedChartInstrument({aiFocus:"GBPUSD",previousAiFocus:"AUDUSD",watchedInstruments:four})).toBeNull();
  });
  it("displays exactly four eligible fallback tabs and distinguishes the research pair",()=>{
    for (const pair of four) expect(isResearchOnlyAiFocus({aiFocus:pair,watchedInstruments:four})).toBe(false);
    expect(isResearchOnlyAiFocus({aiFocus:"USDCHF",watchedInstruments:four})).toBe(true);
    expect(isResearchOnlyAiFocus({aiFocus:null,watchedInstruments:four})).toBe(false);
    expect(resolveDemoChartInstruments(null)).toEqual(four);
  });
});
