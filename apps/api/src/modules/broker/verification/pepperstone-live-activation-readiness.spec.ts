import * as fs from 'node:fs';
import * as path from 'node:path';
const src=fs.readFileSync(path.resolve(__dirname,'../../../../scripts/validation/pepperstone-live-activation-readiness-ro.cjs'),'utf8');
describe('Pepperstone LIVE no-order certification readiness',()=>{
  it('only reports read-only state and cannot authorize real orders',()=>{
    expect(src).toContain("await db.query('BEGIN READ ONLY')");
    expect(src).toContain("await db.query('ROLLBACK')");
    expect(src).toContain('executionPermissionChanged:false');
    expect(src).toContain('realBrokerOrdersSent:false');
    expect(src).toContain("providerLiveCertification:'NOT_CERTIFIED'");
    expect(src).not.toMatch(/adapter\.(placeOrder|modifyOrder|closeOrder|cancelOrder|connect)\s*\(/);
    expect(src).not.toMatch(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(broker|trading|reconciliation)\./);
  });
  it('never confuses account linkage with full LIVE certification',()=>{
    expect(src).toContain('REAL_LIVE_CANARY_ORDER_STOP_EXIT_RECONCILIATION_NOT_CERTIFIED');
    expect(src).toContain("savedOAuthTradingScope:'NOT_INDEPENDENTLY_ATTESTED'");
    expect(src).toContain("canaryPlaceStopCloseReconcileEvidence:'NOT_FOUND'");
  });
  it('distinguishes an active DEMO session from an unauthorized LIVE session',()=>{
    expect(src).toContain('DEMO_SESSION_ACTIVE_DO_NOT_INTERRUPT_FOR_DEPLOYMENT');
    expect(src).toContain('UNAUTHORIZED_ACTIVE_LIVE_SESSION_REQUIRES_RECONCILIATION');
  });
  it('does not print credentials or account IDs in the diagnostic JSON',()=>{
    expect(src).toContain('accountIdsReturned:false');
    expect(src).not.toContain('encrypted_credentials');
    expect(src).not.toContain('broker_connection_id AS user');
  });
});
