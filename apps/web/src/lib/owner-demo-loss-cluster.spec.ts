import type { TradeExecutionView } from "@irexpro/types/execution";
import { detectOwnerDemoLossCluster as detect } from "./owner-demo-loss-cluster";

const NOW = new Date("2026-11-19T03:02:00.000Z");
const trade = (id: string, closedAt: string, realised: string,
 commission: string | null, overrides: Partial<TradeExecutionView> = {}) =>
  ({
    id, status: "CLOSED", accountCurrency: "USD",
    realisedPnl: realised, commission, swap: "0",
    instrument: "EURUSD", direction: "BUY",
    closedAt, openedAt: "2026-11-19T02:15:00.000Z",
    ...overrides,
  }) as TradeExecutionView;
const a = trade("eur-loss", "2026-11-19T02:56:08.084Z", "-58.80", "-7.20");
const b = trade("cad-loss", "2026-11-19T02:56:07.945Z", "-48.77", "8.40",
  { instrument: "USDCAD", direction: "SELL" });

describe("owner USD DEMO repeated-loss advisory", () => {
  it("finds latest two broker-settled losses and counts commission once", () => {
    const r = detect([b, a], NOW);
    expect(r?.netUsd).toBe(-123.17);
    expect(r?.trades.map(x => x.netUsd)).toEqual([-66, -57.17]);
    expect(r?.latestClosedAt).toBe(a.closedAt);
    expect(r?.incidentId).toContain("eur-loss");
  });
  it("does not alert for a win in the latest two settled trades", () => {
    const win = trade("new-win", "2026-11-19T02:59:00Z", "25", "-6");
    expect(detect([a, b, win], NOW)).toBeNull();
  });
  it("does not alert on one loss or tiny losses", () => {
    expect(detect([a], NOW)).toBeNull();
    expect(detect([
      trade("one", "2026-11-19T02:58:01Z", "-1", "-0.06"),
      trade("two", "2026-11-19T02:58:00Z", "-1", "-0.06"),
    ], NOW)).toBeNull();
  });
  it("never makes up net P&L when broker commission or swap is missing", () => {
    expect(detect([a, { ...b, commission: null }], NOW)).toBeNull();
    expect(detect([a, { ...b, swap: null }], NOW)).toBeNull();
    expect(detect([a, { ...b, realisedPnl: null }], NOW)).toBeNull();
  });
  it("requires same currency, completed records and a fresh correlated cluster", () => {
    expect(detect([a, { ...b, accountCurrency: "EUR" }], NOW)).toBeNull();
    expect(detect([a, { ...b, status: "OPEN" }], NOW)).toBeNull();
    expect(detect([a, { ...b, closedAt: "2026-11-19T02:40:00Z" }], NOW)).toBeNull();
    expect(detect([a, b], new Date("2026-11-19T05:00:00Z"))).toBeNull();
  });
  it("keeps overlapping 3-loss cluster visible after a later AUDUSD broker close", () => {
    const late = trade("aud-loss", "2026-11-19T03:02:07.939Z", "-46.44", "-10.32",
      { instrument: "AUDUSD", direction: "BUY" });
    const three = detect([a, b, late], new Date("2026-11-19T03:24:00Z"));
    expect(three?.trades.map(x => x.instrument)).toEqual([
      "AUDUSD", "EURUSD", "USDCAD",
    ]);
    expect(three?.netUsd).toBe(-179.93);
    expect(three?.latestClosedAt).toBe(late.closedAt);
  });
  it("does not collect an older loss beyond ten minutes into the new incident", () => {
    const recent = trade("last", "2026-11-19T03:10:00Z", "-30", "-6");
    const middle = trade("middle", "2026-11-19T03:04:00Z", "-26", "-6");
    const old = trade("old", "2026-11-19T02:50:00Z", "-80", "-6");
    const result = detect([recent, middle, old],
      new Date("2026-11-19T03:11:00Z"));
    expect(result?.netUsd).toBe(-68);
    expect(result?.trades).toHaveLength(2);
  });
  it("de-duplicates trade identity; cannot mistake the same trade for two losses", () => {
    expect(detect([a, { ...a }], NOW)).toBeNull();
  });
  it("ignores future-dated and out-of-order invalid settlements", () => {
    expect(detect([a, { ...b, closedAt: "2026-11-19T05:00:00Z" }], NOW)).toBeNull();
    expect(detect([a, { ...b, closedAt: "invalid-date" }], NOW)).toBeNull();
  });
});
