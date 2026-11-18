import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrategyLossBrakeNotice, type StrategyLossBrakeOwnerStatus } from "./StrategyLossBrakeNotice";
const base:StrategyLossBrakeOwnerStatus={
 supported:true,active:true,accountType:"DEMO",currency:"USD",
 summary:"Strategy loss protection active",
 otherModelAndBrokerRiskChecksRemainActive:true,
 overridesHardAccountOrBrokerRisk:false,noAutomaticSideReversal:true,
 incidents:[{
  id:"CONFIRMED_REVERSAL|USDJPY|SELL|2026-11-18T14:22:47.343Z",
  route:"CONFIRMED_REVERSAL",instrument:"USDJPY",direction:"SELL",
  reason:"PERSISTENT_NEGATIVE_PAYOFF",latestBlockedAt:"2026-11-18T20:59:00Z",
  incidentClosedAt:"2026-11-18T14:22:47.343Z",
  cooldownRemainingSeconds:19000,persistentNegativePayoff:true,
  payoffTrades:8,profitFactor:.4895,recentWins:2,recentLosses:0,
  userDecision:null,resumeLimitedAuthorized:false,requiresOwnerDecision:true,
  recoveryLotCap:1,maxRecoveryEntries:1,remainingConsentSeconds:0,
 }],
};
beforeAll(()=>{
 window.requestAnimationFrame=(fn:FrameRequestCallback)=>
  window.setTimeout(()=>fn(performance.now()),0);
 window.cancelAnimationFrame=(id:number)=>window.clearTimeout(id);
});
describe("Owner strategy-level loss modal",()=>{
 it("does not display the incident to unsupported accounts",()=>{
  render(<StrategyLossBrakeNotice status={{...base,supported:false}} onDecision={jest.fn()}/>);
  expect(screen.queryByTestId("strategy-loss-brake-alert")).not.toBeInTheDocument();
 });
 it("automatically opens a distinct per-strategy incident with actual risk facts",async()=>{
  render(<StrategyLossBrakeNotice status={base} onDecision={jest.fn()}/>);
  await screen.findByTestId("strategy-loss-brake-dialog");
  expect(screen.getAllByText(/USDJPY SELL/).length).toBeGreaterThan(0);
  expect(screen.getByText("0.49")).toBeInTheDocument();
  expect(screen.getByText(/maximum|at most/i)).toBeInTheDocument();
 });
 it("prevents recovery without explicit risk acceptance",async()=>{
  const onDecision=jest.fn().mockResolvedValue(undefined);
  render(<StrategyLossBrakeNotice status={base} onDecision={onDecision}/>);
  const action=await screen.findByRole("button",{name:/Authorize one capped DEMO/i});
  expect(action).toBeDisabled();
  fireEvent.click(action);expect(onDecision).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(action).toBeEnabled();
  await act(async()=>fireEvent.click(action));
  expect(onDecision).toHaveBeenCalledWith(base.incidents[0],"RESUME_LIMITED",true);
 });
 it("never swaps out an undecided alert when another incident appears on refresh",async()=>{
  const next={...base.incidents[0],
    id:"CONFIRMED_REVERSAL|EURUSD|BUY|2026-11-18T14:22:47.343Z",
    instrument:"EURUSD",direction:"BUY" as const,
  };
  const {rerender}=render(<StrategyLossBrakeNotice status={base} onDecision={jest.fn()}/>);
  await screen.findByTestId("strategy-loss-brake-dialog");
  expect(screen.getByRole("alertdialog")).toHaveTextContent("USDJPY SELL");
  rerender(<StrategyLossBrakeNotice
    status={{...base,incidents:[base.incidents[0],next]}} onDecision={jest.fn()}/>);
  expect(screen.getByRole("alertdialog")).toHaveTextContent("USDJPY SELL");
  expect(screen.getByRole("alertdialog")).not.toHaveTextContent("EURUSD BUY");
 });
 it("allows keeping this strategy paused without checking the risk box",async()=>{
  const onDecision=jest.fn().mockResolvedValue(undefined);
  render(<StrategyLossBrakeNotice status={base} onDecision={onDecision}/>);
  await screen.findByTestId("strategy-loss-brake-dialog");
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:/Keep this strategy-direction paused/i})));
  expect(onDecision).toHaveBeenCalledWith(base.incidents[0],"KEEP_PAUSED",false);
 });
 it("defers auto-opening until portfolio-wide decision is resolved",async()=>{
  const {rerender}=render(<StrategyLossBrakeNotice status={base}
   onDecision={jest.fn()} deferAutoOpen/>);
  expect(screen.queryByTestId("strategy-loss-brake-dialog")).not.toBeInTheDocument();
  rerender(<StrategyLossBrakeNotice status={base} onDecision={jest.fn()} deferAutoOpen={false}/>);
  expect(await screen.findByTestId("strategy-loss-brake-dialog")).toBeInTheDocument();
 });
 it("does not automatically reopen a reviewed or already-consented incident",async()=>{
  render(<StrategyLossBrakeNotice status={{...base,incidents:[{
   ...base.incidents[0],requiresOwnerDecision:false,userDecision:"KEEP_PAUSED",
  }]}} onDecision={jest.fn()}/>);
  expect(screen.queryByTestId("strategy-loss-brake-dialog")).not.toBeInTheDocument();
  expect(screen.getByText("Owner kept paused")).toBeInTheDocument();
 });
});
