import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { OwnerDemoLossClusterNotice } from "./OwnerDemoLossClusterNotice";
import type { OwnerDemoLossCluster } from "@/lib/owner-demo-loss-cluster";

const incident: OwnerDemoLossCluster = {
  incidentId: "EUR-closed|CAD-closed|2026-11-19T02:56:08Z",
  latestClosedAt: "2026-11-19T02:56:08Z",
  trades: [
    { id: "EUR-closed", instrument: "EURUSD", direction: "BUY", netUsd: -66 },
    { id: "CAD-closed", instrument: "USDCAD", direction: "SELL", netUsd: -57.17 },
  ],
  netUsd: -123.17,
};

describe("owner DEMO loss cluster advisory dialog", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("automatically informs owner once; continue never calls Stop Trading", async () => {
    const stop = jest.fn();
    const view = render(
      <OwnerDemoLossClusterNotice incident={incident} brokerConnectionId="demo-1"
        active={true} onReviewStop={stop} />,
    );
    const panel = await screen.findByRole("alertdialog");
    expect(panel).toHaveTextContent("$123.17");
    expect(panel).toHaveTextContent("EURUSD BUY");
    expect(panel).toHaveTextContent("USDCAD SELL");
    expect(panel).toHaveTextContent("AI Trading");
    fireEvent.click(screen.getByRole("button", { name: "Continue Trading" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();
    view.unmount();
    render(
      <OwnerDemoLossClusterNotice incident={incident} brokerConnectionId="demo-1"
        active={true} onReviewStop={stop} />,
    );
    await waitFor(() => expect(
      screen.queryByRole("alertdialog"),
    ).not.toBeInTheDocument());
    expect(stop).not.toHaveBeenCalled();
  });

  it("Stop Trading is ONLY a request to show the existing session confirmation", async () => {
    const reviewStop = jest.fn();
    render(
      <OwnerDemoLossClusterNotice incident={incident} brokerConnectionId="demo-1"
        active={true} onReviewStop={reviewStop} />,
    );
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Stop Trading…" }));
    expect(reviewStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("never displays or changes state for stopped or other broker sessions", () => {
    const reviewStop = jest.fn();
    const { rerender } = render(
      <OwnerDemoLossClusterNotice incident={incident} brokerConnectionId="demo-1"
        active={false} onReviewStop={reviewStop} />,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("owner-demo-loss-cluster-banner")).not.toBeInTheDocument();
    rerender(
      <OwnerDemoLossClusterNotice incident={null} brokerConnectionId="demo-1"
        active={true} onReviewStop={reviewStop} />,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(reviewStop).not.toHaveBeenCalled();
  });

  it("respects another confirmation already open", () => {
    render(
      <OwnerDemoLossClusterNotice incident={incident} brokerConnectionId="demo-1"
        active={true} deferAutoOpen={true} onReviewStop={jest.fn()} />,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
