import '@testing-library/jest-dom';
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  PortfolioLossPauseNotice,
  shouldShowPortfolioBrakeNotice,
  type PortfolioLossPauseStatus,
} from "./PortfolioLossPauseNotice";

const base: PortfolioLossPauseStatus = {
  supported: true, state: "PAUSED", active: true,
  requiresOwnerDecision: true, resumeAuthorized: false,
  userDecision: null,
  incidentClosedAt: "2026-11-18T12:05:33.982Z",
  brakeExpiresAt: "2026-11-18T14:05:33.982Z",
  remainingSeconds: 1400, consecutiveNetLosses: 3,
  lastThreeNetUsd: -159.1,
  recentLosses: [
    { closedAt: "2026-11-18T12:05:33.982Z", instrument: "AUDUSD",
      direction: "SELL", netUsd: -81.88 },
  ],
  reason: "Three losses",brokerAccountType:"DEMO", currency:"USD",
  canOverrideCurrentIncident:true, otherRiskChecksRemainActive:true,
};
beforeAll(() => {
  window.requestAnimationFrame = (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
});

describe("DEMO account-owned loss pause notice", () => {
  it("never appears for clear, other account or unsupported state", () => {
    expect(shouldShowPortfolioBrakeNotice(null)).toBe(false);
    expect(shouldShowPortfolioBrakeNotice({ ...base, supported:false })).toBe(false);
    expect(shouldShowPortfolioBrakeNotice({ ...base, active:false, state:"CLEAR" })).toBe(false);
  });

  it("shows actual losses and auto opens a risk dialog", async () => {
    render(<PortfolioLossPauseNotice status={base} onDecision={jest.fn()} />);
    await screen.findByTestId("portfolio-loss-pause-dialog");
    expect(screen.getAllByText(/159\.10/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Nov 18/).length).toBeGreaterThan(0);
    expect(screen.getByText(/margin, drawdown/i)).toBeInTheDocument();
  });

  it("cannot approve resume without an explicit risk checkbox", async () => {
    const onDecision=jest.fn().mockResolvedValue(undefined);
    render(<PortfolioLossPauseNotice status={base} onDecision={onDecision} />);
    const resume = await screen.findByRole("button", { name:/Accept risk/i });
    expect(resume).toBeDisabled();
    fireEvent.click(resume);
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(resume).toBeEnabled();
    await act(async()=>{fireEvent.click(resume);});
    expect(onDecision).toHaveBeenCalledWith("RESUME",true,base.incidentClosedAt);
  });

  it("keeps pause without risk acknowledgement, respects server WAITING state", async () => {
    const onDecision=jest.fn().mockResolvedValue(undefined);
    const { rerender }=render(
      <PortfolioLossPauseNotice status={base} onDecision={onDecision} />);
    const hold=await screen.findByRole("button", { name:/Keep trading paused/i });
    await act(async()=>{fireEvent.click(hold);});
    expect(onDecision).toHaveBeenCalledWith("KEEP_PAUSED",false,base.incidentClosedAt);
    rerender(<PortfolioLossPauseNotice status={{...base,state:"WAITING",
      requiresOwnerDecision:false,userDecision:"KEEP_PAUSED"}} onDecision={onDecision} />);
    expect(screen.queryByTestId("portfolio-loss-pause-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("portfolio-loss-pause-alert")).toBeInTheDocument();
  });

  it("allows owner to reinstate pause after overriding the current incident", async () => {
    const onDecision=jest.fn().mockResolvedValue(undefined);
    render(<PortfolioLossPauseNotice status={{...base,state:"OVERRIDDEN",
      requiresOwnerDecision:false,userDecision:"RESUME",resumeAuthorized:true}}
      onDecision={onDecision}/>);
    fireEvent.click(screen.getByRole("button", { name:/Reinstate safety pause/i }));
    await act(async()=>{
      fireEvent.click(screen.getAllByRole("button",{name:/Reinstate safety pause/i})[1]);
    });
    expect(onDecision).toHaveBeenCalledWith("KEEP_PAUSED",false,base.incidentClosedAt);
  });
});
