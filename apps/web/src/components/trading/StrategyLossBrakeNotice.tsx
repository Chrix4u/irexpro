"use client";
import { useEffect, useId, useRef, useState } from "react";
import "./portfolio-loss-pause.css";

export interface StrategyLossBrakeIncident {
  id:string;
  route:"EARLY_TRANSITION"|"CONFIRMED_REVERSAL";
  instrument:string;direction:"BUY"|"SELL";reason:string;
  latestBlockedAt:string;incidentClosedAt:string;
  cooldownRemainingSeconds:number;persistentNegativePayoff:boolean;
  payoffTrades:number;profitFactor:number|null;recentWins:number;recentLosses:number;
  userDecision:"KEEP_PAUSED"|"RESUME_LIMITED"|null;
  resumeLimitedAuthorized:boolean;requiresOwnerDecision:boolean;
  recoveryLotCap:number;maxRecoveryEntries:1;remainingConsentSeconds:number;
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
  onDecision:(item:StrategyLossBrakeIncident,action:"KEEP_PAUSED"|"RESUME_LIMITED",
    acknowledged:boolean)=>Promise<void>;
}
const strategyName=(value:string)=>value==="EARLY_TRANSITION"?"Early Transition":"Confirmed Reversal";
const describe=(reason:string)=>reason==="PERSISTENT_NEGATIVE_PAYOFF"
  ?"Persistently losing after commissions":reason==="RECENT_NEGATIVE_PAYOFF"
  ?"Recent negative payoff":reason==="RECENT_MULTIMODEL_LOSS_STREAK"
  ?"Repeated recent losing positions":"Strategy loss protection";
const time=(value:string)=>new Date(value).toLocaleString(undefined,{
  dateStyle:"medium",timeStyle:"short",
});
export function StrategyLossBrakeNotice({status,error,saving=false,
  deferAutoOpen=false,onDecision}:Props) {
  const [selected,setSelected]=useState<string|null>(null);
  const [ack,setAck]=useState(false);
  const [busy,setBusy]=useState(false);
  const seen=useRef<Set<string>>(new Set());
  const closeRef=useRef<HTMLButtonElement>(null);
  const panelRef=useRef<HTMLElement>(null);
  const priorFocus=useRef<HTMLElement|null>(null);
  const headingId=useId();
  const descriptionId=useId();
  const items=status?.supported&&status.active?status.incidents:[];
  const item=items.find(x=>x.id===selected)||null;

  useEffect(()=>{
    if(deferAutoOpen||!status?.supported)return;
    const next=status.incidents.find(x=>x.requiresOwnerDecision&&!seen.current.has(x.id));
    if(!next)return;
    seen.current.add(next.id);
    setAck(false);
    setSelected(next.id);
  },[status,deferAutoOpen]);

  useEffect(()=>{
    if(!item)return;
    priorFocus.current=document.activeElement as HTMLElement|null;
    const old=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const frame=requestAnimationFrame(()=>closeRef.current?.focus());
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==="Escape"&&!busy){event.preventDefault();setSelected(null);}
      if(event.key!=="Tab")return;
      const buttons=Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')||[]);
      if(!buttons.length)return;
      const first=buttons[0],last=buttons[buttons.length-1];
      const focus=document.activeElement;
      if(event.shiftKey&&(focus===first||!panelRef.current?.contains(focus))){
        event.preventDefault();last.focus();
      }else if(!event.shiftKey&&(focus===last||!panelRef.current?.contains(focus))){
        event.preventDefault();first.focus();
      }
    };
    document.addEventListener("keydown",onKey,true);
    return ()=>{
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown",onKey,true);
      document.body.style.overflow=old;
      priorFocus.current?.focus?.();
    };
  },[item?.id,busy]);

  if(!status?.supported||!items.length)return null;
  const decide=async(action:"KEEP_PAUSED"|"RESUME_LIMITED")=>{
    if(!item||busy||saving||(action==="RESUME_LIMITED"&&!ack))return;
    setBusy(true);
    try{
      await onDecision(item,action,action==="RESUME_LIMITED"&&ack);
      setSelected(null);setAck(false);
    }catch{
      // Failed owner consent never implies broker entry authority.
    }finally{setBusy(false);}
  };
  return (
    <>
      <section role="alert" aria-live="polite"
        className="portfolio-brake-alert" data-testid="strategy-loss-brake-alert">
        <div className="portfolio-brake-alert__header">
          <span className="portfolio-brake-alert__tag">DEMO · STRATEGY LOSS PROTECTION</span>
          <strong>{items.length} restricted strategy-direction {items.length===1?"incident":"incidents"}</strong>
        </div>
        <p>Trade entries have been blocked by model-specific loss safeguards.
          These are different from the portfolio-wide two-hour pause.</p>
        <div className="strategy-loss-alert__items">
          {items.map(x=>(
            <button type="button" key={x.id} className="strategy-loss-alert__item"
              onClick={()=>{seen.current.add(x.id);setAck(false);setSelected(x.id);}}>
              <strong>{strategyName(x.route)} · {x.instrument} {x.direction}</strong>
              <span>{x.resumeLimitedAuthorized?"One limited recovery approved":
                x.userDecision==="KEEP_PAUSED"?"Owner kept paused":
                  x.userDecision==="RESUME_LIMITED"?"Limited approval used or expired":
                    "Owner decision needed"}</span>
              <span>Review</span>
            </button>
          ))}
        </div>
        <p className="portfolio-brake-alert__fine">Trading cannot resume simply by dismissing this alert.
          All broker, account-loss, margin, stop-loss and market-safety protections remain active.</p>
      </section>
      {item&&(
        <div className="portfolio-brake-overlay">
          <section ref={panelRef} role="alertdialog" aria-modal="true" tabIndex={-1}
            aria-labelledby={headingId} aria-describedby={descriptionId}
            className="portfolio-brake-dialog" data-testid="strategy-loss-brake-dialog">
            <header>
              <span className="portfolio-brake-alert__tag">ACCOUNT OWNER DECISION · DEMO ONLY</span>
              <h2 id={headingId}>Strategy trading restricted</h2>
            </header>
            <p id={descriptionId}><strong>{strategyName(item.route)} · {item.instrument} {item.direction}</strong>
              {" "}is restricted: {describe(item.reason)}. This is not the portfolio-loss pause.</p>
            <div className="portfolio-brake-facts">
              <div><span>Broker payoff trades</span><strong>{item.payoffTrades}</strong></div>
              <div><span>Historical profit factor</span>
                <strong>{item.profitFactor===null?"Unavailable":item.profitFactor.toFixed(2)}</strong></div>
              <div><span>Normal cooldown</span>
                <strong>{Math.ceil(item.cooldownRemainingSeconds/60)} min left</strong></div>
            </div>
            <p>The brake was observed {time(item.latestBlockedAt)}. A persistent-loss
              condition may remain active after its ordinary cooldown ends.</p>
            {item.resumeLimitedAuthorized&&(
              <p className="portfolio-brake-alert__fine">
                The owner approved at most one new recovery entry (maximum {item.recoveryLotCap.toFixed(2)} lot).
                Approval expires in {Math.ceil(item.remainingConsentSeconds/60)} minute(s).
                This does not guarantee a trade will qualify.
              </p>
            )}
            <p className="portfolio-brake-warning">
              <strong>Additional-loss warning:</strong> A controlled recovery attempt can lose money.
              Explicit permission is limited to one new DEMO position, at most
              {" "}{item.recoveryLotCap.toFixed(2)} lot, and one hour. It does not
              bypass portfolio brakes, broker margin, model admission, fresh quotes,
              valid stops, drawdown limits or other safeguards.
            </p>
            {item.userDecision!=="RESUME_LIMITED"&&(
              <label className="portfolio-brake-checkbox">
                <input type="checkbox" checked={ack} disabled={busy||saving}
                  onChange={e=>setAck(e.target.checked)} />
                <span>I understand that authorizing one limited DEMO recovery entry
                  despite poor historical performance may cause another loss.</span>
              </label>
            )}
            {error&&<p role="alert" className="portfolio-brake-error">{error}</p>}
            <div className="portfolio-brake-actions">
              <button type="button" ref={closeRef} className="btn btn--secondary"
                disabled={busy||saving} onClick={()=>setSelected(null)}>Review later</button>
              <button type="button" className="btn btn--secondary"
                disabled={busy||saving} onClick={()=>void decide("KEEP_PAUSED")}>
                Keep this strategy-direction paused
              </button>
              {item.userDecision!=="RESUME_LIMITED"&&(
                <button type="button" className="btn btn--danger"
                  disabled={busy||saving||!ack}
                  onClick={()=>void decide("RESUME_LIMITED")}>
                  Authorize one capped DEMO recovery entry
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
