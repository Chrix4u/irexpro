import "@testing-library/jest-dom";
import React from "react";
import {act,fireEvent,render,screen} from "@testing-library/react";
import {StrategyLossBrakeNotice,type StrategyLossBrakeOwnerStatus} from "./StrategyLossBrakeNotice";
const state:StrategyLossBrakeOwnerStatus={
 supported:true,active:true,accountType:"DEMO",currency:"USD",
 summary:"Owner strategy decisions",
 otherModelAndBrokerRiskChecksRemainActive:true,
 overridesHardAccountOrBrokerRisk:false,noAutomaticSideReversal:true,
 incidents:[{
  id:"CONFIRMED_REVERSAL|USDJPY|SELL|2026-11-18T14:22:47.343Z",
  route:"CONFIRMED_REVERSAL",instrument:"USDJPY",direction:"SELL",
  reason:"PERSISTENT_NEGATIVE_PAYOFF",latestBlockedAt:"2026-11-18T20:59:00Z",
  incidentClosedAt:"2026-11-18T14:22:47.343Z",
  cooldownRemainingSeconds:19000,persistentNegativePayoff:true,
  payoffTrades:8,profitFactor:.4895,recentWins:2,recentLosses:0,
  userDecision:null,continueTradingAuthorized:false,requiresOwnerDecision:true,
 }],
};
beforeAll(()=>{
 window.requestAnimationFrame=(f:FrameRequestCallback)=>window.setTimeout(()=>f(performance.now()),0);
 window.cancelAnimationFrame=(i:number)=>window.clearTimeout(i);
});
describe("Simple owner DEMO strategy pause decision",()=>{
 it("does not expose another account's incidents",()=>{
  render(<StrategyLossBrakeNotice status={{...state,supported:false}} onDecision={jest.fn()}/>);
  expect(screen.queryByTestId("strategy-loss-brake-alert")).not.toBeInTheDocument();
 });
 it("opens a simple two-choice account owner prompt",async()=>{
  render(<StrategyLossBrakeNotice status={state} onDecision={jest.fn()}/>);
  const dialog=await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("USDJPY SELL");
  expect(dialog).toHaveTextContent("Pepperstone DEMO");
  expect(screen.getByRole("button",{name:"Keep Paused"})).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"Continue Trading"})).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(dialog).not.toHaveTextContent("1.00 lot");
  expect(dialog).not.toHaveTextContent("one hour");
 });
 it("Continue Trading requires one explicit button click, no checkbox",async()=>{
  const cb=jest.fn().mockResolvedValue(undefined);
  render(<StrategyLossBrakeNotice status={state} onDecision={cb}/>);
  const button=await screen.findByRole("button",{name:"Continue Trading"});
  await act(async()=>fireEvent.click(button));
  expect(cb).toHaveBeenCalledWith(state.incidents[0],"CONTINUE_TRADING");
 });
 it("Keep Paused sends exact incident and keeps strategy blocked",async()=>{
  const cb=jest.fn().mockResolvedValue(undefined);
  render(<StrategyLossBrakeNotice status={state} onDecision={cb}/>);
  const button=await screen.findByRole("button",{name:"Keep Paused"});
  await act(async()=>fireEvent.click(button));
  expect(cb).toHaveBeenCalledWith(state.incidents[0],"KEEP_PAUSED");
 });
 it("does not interrupt an open modal on a live four-second refresh",async()=>{
  const other={...state.incidents[0],id:"other",instrument:"EURUSD",direction:"BUY" as const};
  const {rerender}=render(<StrategyLossBrakeNotice status={state} onDecision={jest.fn()}/>);
  await screen.findByRole("alertdialog");
  rerender(<StrategyLossBrakeNotice status={{...state,incidents:[state.incidents[0],other]}}
   onDecision={jest.fn()}/>);
  expect(screen.getByRole("alertdialog")).toHaveTextContent("USDJPY SELL");
  expect(screen.getByRole("alertdialog")).not.toHaveTextContent("EURUSD BUY");
 });
 it("defers to any account-wide portfolio decision",async()=>{
  const {rerender}=render(<StrategyLossBrakeNotice status={state} onDecision={jest.fn()}
    deferAutoOpen/>);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  rerender(<StrategyLossBrakeNotice status={state} onDecision={jest.fn()}/>);
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
 });
 it("shows the current owner Continue Trading status with a re-review button",()=>{
  render(<StrategyLossBrakeNotice status={{...state,incidents:[{
   ...state.incidents[0],requiresOwnerDecision:false,
   continueTradingAuthorized:true,userDecision:"CONTINUE_TRADING",
  }]}} onDecision={jest.fn()}/>);
  expect(screen.getByText("Continue Trading selected")).toBeInTheDocument();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
 });
});
