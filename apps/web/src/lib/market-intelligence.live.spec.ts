import { api } from "./api";
import { loadLiveMarketQuote } from "./market-intelligence";

const SNAPSHOT = {
  instrument: "EURUSD",
  timeframe: "M5",
  source: "BROKER",
  status: "FRESH",
  retrievedAt: "2026-10-29T20:00:00.250Z",
  latestCandleAt: "2026-10-29T19:55:00.000Z",
  quote: {
    bid: "1.16501",
    ask: "1.16509",
    spread: "0.00008",
    timestamp: "2026-10-29T20:00:00.200Z",
    freshness: "FRESH",
  },
  candles: [
    {
      timestamp: "2026-10-29T19:55:00.000Z",
      open: "1.16480",
      high: "1.16510",
      low: "1.16470",
      close: "1.16500",
      volume: "42",
    },
  ],
};

describe("live market quote loading", () => {
  afterEach(() => jest.restoreAllMocks());

  it("uses a one-candle snapshot so fast quote refreshes do not reload the 90-bar chart history", async () => {
    const request = jest
      .spyOn(api, "request")
      .mockResolvedValue(SNAPSHOT as any);

    const quote = await loadLiveMarketQuote({
      instrument: "EURUSD",
      timeframe: "M5",
      brokerConnectionId: "ctrader-1",
    });

    expect(request).toHaveBeenCalledWith(
      "/market-data/intelligence?instrument=EURUSD&timeframe=M5&limit=1&brokerConnectionId=ctrader-1",
    );
    expect(quote).toEqual(SNAPSHOT.quote);
  });
});
