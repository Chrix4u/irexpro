import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Pepperstone owner DEMO no-order pilot preflight contract',()=>{
  const script=fs.readFileSync(path.resolve(__dirname,'../../../../scripts/validation/demo-protected-runner-no-order-preflight.cjs'),'utf8');
  it('requires every execution flag OFF and a stopped AI session',()=>{
    expect(script).toContain("if(switches.some(k=>env[k]==='enabled'||process.env[k]==='enabled'))");
    expect(script).toContain("out.tradingSession=p.active_sessions===0?'STOPPED':'ACTIVE'");
    expect(script).toContain('p.live_enabled!==0||p.active_sessions!==0||p.active_trades!==0||p.total_intents!==0');
  });
  it('only reads DEMO credentials, positions, working orders and public symbol metadata',()=>{
    expect(script).toContain("account_type='DEMO'");
    expect(script).toContain('adapter.getOpenPositions()');
    expect(script).toContain('adapter.listOrders()');
    expect(script).toContain('adapter.getInstrumentList()');
    expect(script).not.toMatch(/adapter\.(modifyOrder|placeOrder|closeOrder|cancelOrder|partialCloseOrder)\s*\(/);
    expect(script).not.toMatch(/await\s+db\.query\s*\(\s*['"`]\s*(INSERT|UPDATE|DELETE|TRUNCATE)/i);
  });
  it('never claims a broker stop amendment succeeded without an open position',()=>{
    expect(script).toContain("out.pilotState='NO_OPEN_POSITION_FOR_BROKER_AMENDMENT_UAT'");
    expect(script).toContain('pendingActualStopAmendmentUat:true');
    expect(script).toContain("out.pilotState='PREFLIGHT_FAILED_CLOSED'");
  });
  it('does not write credentials, account identifiers or prices to output',()=>{
    expect(script).not.toMatch(/console\.log\s*\(\s*(credentials|c\.|positions|orders|symbols)/);
    expect(script).toContain('for(const k of Object.keys(credentials))credentials[k]=null');
  });
});
