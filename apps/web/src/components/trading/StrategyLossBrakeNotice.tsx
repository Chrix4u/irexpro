"use client";
import { useEffect, useId, useRef, useState } from "react";
import "./portfolio-loss-pause.css";

export interface StrategyLossBrakeIncident {
  id:string;
  route:"EARLY_TRANSITION"|"CONFIRMED_REVERSAL"|"TREND_CONTINUATION";
  instrument:string;direction:"BUY"|"SELL";reason:string;
  latestBlockedAt:string;incidentClosedAt:string;
  cooldownRemainingSeconds:number;persistentNegativePayoff:boolean;
  payoffTrades:number;profitFactor:number|null;recentWins:number;recentLosses:number;
  userDecision:"KEEP_PAUSED"|"CONTINUE_TRADING"|null;
  continueTradingAuthorized:boolean;requiresOwnerDecision:boolean;
}
export interface StrategyLossBrakeOwnerStatus {
  supported:boolean;active:boolean;accountType:"DEMO"|null;currency:"USD"|null;
  incidents:StrategyLossBrakeIncident[];summary:string;
  otherModelAndBrokerRiskChecksRemainActive:true;
  overridesHardAccountOrBrokerRisk:false;noAutomaticSideReversal:true;
}
interface Props {
  status:StrategyLossBrakeOwnerStatus|null;
  error?:string|null;saving?:boolean;
  deferAutoOpen?:boolean;
  onDecision:(item:StrategyLossBrakeIncident,
    action:"KEEP_PAUSED"|"CONTINUE_TRADING")=>Promise<void>;
}
const strategyName=(name:string)=>
  name==="EARLY_TRANSITION"?"Early Transition":
  name==="TREND_CONTINUATION"?"Trend Continuation":"Confirmed Reversal";
export function StrategyLossBrakeNotice({
  status,error,saving=false,deferAutoOpen=false,onDecision,
}:Props) {
  const [selected,setSelected]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const seen=useRef<Set<string>>(new Set());
  const firstButton=useRef<HTMLButtonElement>(null);
  const panel=useRef<HTMLElement>(null);
  const previousFocus=useRef<HTMLElement|null>(null);
  const headingId=useId(),descriptionId=useId();
  const items=status?.supported&&status.active?status.incidents:[];
  const item=items.find(x=>x.id===selected)||null;
  const selectedId=item?.id??null;

  useEffect(()=>{
    // Keep a modal stable during the 4-second live incident refresh.
    // Review remaining new restrictions one by one rather than interrupting.
    if(selected||deferAutoOpen||!status?.supported)return;
    const next=status.incidents.find(x=>x.requiresOwnerDecision&&!seen.current.has(x.id));
    if(!next)return;
    seen.current.add(next.id);setSelected(next.id);
  },[selected,deferAutoOpen,status]);

  useEffect(()=>{
    if(!selectedId)return;
    previousFocus.current=document.activeElement as HTMLElement|null;
    const old=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const frame=requestAnimationFrame(()=>firstButton.current?.focus());
    const key=(ev:KeyboardEvent)=>{
      if(ev.key==="Escape"&&!busy){ev.preventDefault();setSelected(null);}
      if(ev.key!=="Tab")return;
      const controls=Array.from(panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex]:not([tabindex="-1"])')||[]);
      if(!controls.length)return;
      const active=document.activeElement;
      if(ev.shiftKey&&(active===controls[0]||!panel.current?.contains(active))){
        ev.preventDefault();controls[controls.length-1].focus();
      }else if(!ev.shiftKey&&(active===controls[controls.length-1]||
        !panel.current?.contains(active))){
        ev.preventDefault();controls[0].focus();
      }
    };
    document.addEventListener("keydown",key,true);
    return ()=>{
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown",key,true);
      document.body.style.overflow=old;
      previousFocus.current?.focus?.();
    };
  },[selectedId,busy]);

  if(!status?.supported||!items.length)return null;
  const decide=async(action:"KEEP_PAUSED"|"CONTINUE_TRADING")=>{
    if(!item||busy||saving)return;
    setBusy(true);
    try{await onDecision(item,action);setSelected(null);}
    catch{/* Failed requests retain existing trading protection. */}
    finally{setBusy(false);}
  };
  return (
    <>
      <section role="alert" aria-live="polite"
        className="portfolio-brake-alert" data-testid="strategy-loss-brake-alert">
        <div className="portfolio-brake-alert__header">
          <strong>Strategy Trading Alerts</strong>
          <span className="portfolio-brake-alert__tag">Pepperstone DEMO · USD</span>
        </div>
        <p>Some strategy directions have paused after losses. Choose whether they should stay paused or continue trading.</p>
        <div className="strategy-loss-alert__items">
          {items.map(x=>(
            <button type="button" key={x.id} className="strategy-loss-alert__item"
              onClick={()=>{seen.current.add(x.id);setSelected(x.id);}}>
              <strong>{strategyName(x.route)} · {x.instrument} {x.direction}</strong>
              <span>{x.continueTradingAuthorized?"Continue Trading selected":
                x.userDecision==="KEEP_PAUSED"?"Keep Paused selected":"Decision needed"}</span>
              <span>Review</span>
            </button>
          ))}
        </div>
      </section>
      {item&&(
        <div className="portfolio-brake-overlay">
          <section ref={panel} role="alertdialog" aria-modal="true"
            tabIndex={-1} aria-labelledby={headingId} aria-describedby={descriptionId}
            className="portfolio-brake-dialog" data-testid="strategy-loss-brake-dialog">
            <header>
              <span className="portfolio-brake-alert__tag">Pepperstone DEMO · USD</span>
              <h2 id={headingId}>Strategy Trading Paused</h2>
            </header>
            <p id={descriptionId}>
              <strong>{strategyName(item.route)} · {item.instrument} {item.direction}</strong>
              {" "}was paused after losses. Do you want to keep this strategy direction paused, or allow it to continue trading?
            </p>
            {item.userDecision!==null&&(
              <p>Current choice: <strong>{item.continueTradingAuthorized?"Continue Trading":"Keep Paused"}</strong>.</p>
            )}
            {error&&<p role="alert" className="portfolio-brake-error">{error}</p>}
            <div className="portfolio-brake-actions">
              <button type="button" ref={firstButton} className="btn btn--secondary"
                disabled={busy||saving} onClick={()=>void decide("KEEP_PAUSED")}>
                Keep Paused
              </button>
              <button type="button" className="btn btn--primary"
                disabled={busy||saving} onClick={()=>void decide("CONTINUE_TRADING")}>
                Continue Trading
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
