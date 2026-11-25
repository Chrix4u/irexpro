import { estimatePepperstoneDemoRoundTripCommission as estimate } from "./open-commission-presentation";

const openPosition = {
  brokerName: "Pepperstone cTrader",
  environment: "DEMO" as const,
  accountCurrency: "USD",
  commission: "-5.10",
  lotSize: "1.70",
};

describe("open-position commission is not completed round-trip cost", () => {
  it("separates broker-booked entry leg from an explicitly estimated exit leg", () => {
    expect(estimate(openPosition)).toEqual({
      estimatedClosingCommission: "-5.10",
      estimatedTotalCommission: "-10.20",
    });
    expect(estimate({ ...openPosition, lotSize: "1.72", commission: "-5.16" })).toEqual({
      estimatedClosingCommission: "-5.16",
      estimatedTotalCommission: "-10.32",
    });
  });

  it("never double estimates a commission already booked round trip", () => {
    expect(estimate({ ...openPosition, commission: "-10.20" })).toBeNull();
  });

  it("does not guess missing or abnormal broker costs", () => {
    expect(estimate({ ...openPosition, commission: null })).toBeNull();
    expect(estimate({ ...openPosition, commission: "0" })).toBeNull();
    expect(estimate({ ...openPosition, commission: "+5.10" })).toBeNull();
    expect(estimate({ ...openPosition, commission: "n/a" })).toBeNull();
    expect(estimate({ ...openPosition, lotSize: "0" })).toBeNull();
  });

  it("cannot invent a charge for LIVE, PAPER, other broker, or other currency", () => {
    expect(estimate({ ...openPosition, environment: "LIVE" })).toBeNull();
    expect(estimate({ ...openPosition, environment: "PAPER" })).toBeNull();
    expect(estimate({ ...openPosition, accountCurrency: "EUR" })).toBeNull();
    expect(estimate({ ...openPosition, brokerName: "Other cTrader" })).toBeNull();
  });
});
