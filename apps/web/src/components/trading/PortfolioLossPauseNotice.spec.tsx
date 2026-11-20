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

  it("automatically pops up when an already open trading page receives a NEW pause", async () => {
    const { rerender } = render(
      <PortfolioLossPauseNotice status={{ ...base, active:false, state:"CLEAR",
        requiresOwnerDecision:false,incidentClosedAt:null }}
        onDecision={jest.fn()} />,
    );
    expect(screen.queryByTestId("portfolio-loss-pause-dialog")).not.toBeInTheDocument();
    rerender(<PortfolioLossPauseNotice status={base} onDecision={jest.fn()} />);
    expect(await screen.findByTestId("portfolio-loss-pause-dialog")).toBeInTheDocument();
  });

  it("auto-alerts once per incident and alerts again for the NEXT distinct incident", async () => {
    const onDecision=jest.fn().mockResolvedValue(undefined);
    const { rerender }=render(
      <PortfolioLossPauseNotice status={base} onDecision={onDecision} />,
    );
    await screen.findByTestId("portfolio-loss-pause-dialog");
    fireEvent.click(screen.getByRole("button", { name:"Review later" }));
    expect(screen.queryByTestId("portfolio-loss-pause-dialog")).not.toBeInTheDocument();

    // Repeated polls of the same incident must NOT repeatedly reopen it.
    rerender(<PortfolioLossPauseNotice status={{ ...base }} onDecision={onDecision} />);
    expect(screen.queryByTestId("portfolio-loss-pause-dialog")).not.toBeInTheDocument();

    // A newer broker loss-closing incident REQUIRES fresh owner approval.
    rerender(<PortfolioLossPauseNotice status={{
      ...base, incidentClosedAt:"2026-11-18T15:00:00.000Z",
      brakeExpiresAt:"2026-11-18T17:00:00.000Z",
    }} onDecision={onDecision} />);
    expect(await screen.findByTestId("portfolio-loss-pause-dialog")).toBeInTheDocument();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("does not auto-reopen an incident after its server-recorded WAIT decision", async () => {
    const onDecision=jest.fn();
    const { rerender }=render(
      <PortfolioLossPauseNotice status={{ ...base,
        userDecision:"KEEP_PAUSED",state:"WAITING",requiresOwnerDecision:false }}
        onDecision={onDecision} />,
    );
    expect(screen.getByTestId("portfolio-loss-pause-alert")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-loss-pause-dialog")).not.toBeInTheDocument();
    rerender(<PortfolioLossPauseNotice status={{ ...base,
      userDecision:"KEEP_PAUSED",state:"WAITING",requiresOwnerDecision:false }}
      onDecision={onDecision} />);
    expect(screen.queryByTestId("portfolio-loss-pause-dialog")).not.toBeInTheDocument();
  });

  it("allows keyboard dismissal without consenting to extra loss risk", async () => {
    const onDecision=jest.fn();
    render(<PortfolioLossPauseNotice status={base} onDecision={onDecision} />);
    await screen.findByTestId("portfolio-loss-pause-dialog");
    fireEvent.keyDown(document, { key:"Escape" });
    expect(screen.queryByTestId("portfolio-loss-pause-dialog")).not.toBeInTheDocument();
    expect(onDecision).not.toHaveBeenCalled();
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
