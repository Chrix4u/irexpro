from pathlib import Path


def edit(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    if new in s:
        return
    if old not in s:
        raise SystemExit(f"expected patch anchor missing: {path}: {old[:100]!r}")
    p.write_text(s.replace(old, new, 1))


def ensure_name(path: str, cls: str) -> None:
    p = Path(path)
    s = p.read_text()
    line = f"  name = '{cls}';"
    if line in s:
        return
    anchor = f"export class {cls} implements MigrationInterface {{\n"
    if anchor not in s:
        raise SystemExit(f"class anchor missing: {path}: {cls}")
    p.write_text(s.replace(anchor, anchor + line + "\n", 1))


ensure_name('apps/api/src/database/migrations/1754400000000-AddTradeAuthorityLinkage.ts', 'AddTradeAuthorityLinkage1754400000000')
ensure_name('apps/api/src/database/migrations/1754400000000-TradeIntentRound6LiveCompletion.ts', 'TradeIntentRound6LiveCompletion1754400000000')
ensure_name('apps/api/src/database/migrations/1754500000000-PortfolioAllocationRound6LiveCompletion.ts', 'PortfolioAllocationRound6LiveCompletion1754500000000')

exec_pg = 'apps/api/src/modules/execution/execution.pg-integration.spec.ts'
edit(exec_pg,
     '      opening_balance NUMERIC(15,2),\n      peak_equity NUMERIC(15,2),',
     '      opening_balance NUMERIC(15,2),\n      account_currency VARCHAR(3),\n      opening_snapshot_id UUID,\n      opening_snapshot_generation INTEGER,\n      peak_equity NUMERIC(15,2),')
edit(exec_pg,
     '      execution_control_revision INTEGER,\n      order_payload_digest VARCHAR(64) NOT NULL,',
     '      execution_control_revision INTEGER,\n      authority_binding_digest VARCHAR(64),\n      trading_policy_revision INTEGER,\n      provider_verification_revision INTEGER,\n      order_payload_digest VARCHAR(64) NOT NULL,')
edit(exec_pg,
     '      trailing_stop_pips NUMERIC(8,2), external_order_id VARCHAR(255), status VARCHAR(32) NOT NULL DEFAULT \'PENDING\',',
     '      trailing_stop_pips NUMERIC(8,2), external_order_id VARCHAR(255), external_position_id VARCHAR(255),\n      commission NUMERIC(18,8), swap NUMERIC(18,8), status VARCHAR(32) NOT NULL DEFAULT \'PENDING\',')
edit(exec_pg,
     '      dispatch_certainty VARCHAR(30), opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
     '      dispatch_certainty VARCHAR(30), trading_session_id UUID, logical_account_key VARCHAR(255), account_currency VARCHAR(3),\n      risk_period_id UUID, trade_intent_id UUID, risk_grant_id UUID, order_id UUID,\n      opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),')
edit(exec_pg,
     "    const adapterRegistry = {\n      getAdapter: jest.fn().mockReturnValue(adapter),\n    } as unknown as BrokerAdapterRegistry;",
     "    const adapterRegistry = {\n      getAdapter: jest.fn().mockReturnValue(adapter),\n      getAdapterForConnection: jest.fn().mockReturnValue(adapter),\n    } as unknown as BrokerAdapterRegistry;")
edit(exec_pg,
     '      { getCurrentGeneration: jest.fn() } as never,',
     '      { getCurrentGeneration: jest.fn().mockResolvedValue(1) } as never,')
edit(exec_pg,
     '    );\n    const tradeCas = new TradeLifecycleCasService(tradeRepo, auditService);',
     '    );\n    // PG harness: route orchestrator dispatch commitment through the same real\n    // FinalDispatchBoundary instance used by ExecutionService.\n    (orchestrator as unknown as { finalDispatchBoundary: FinalDispatchBoundary })\n      .finalDispatchBoundary = boundary;\n    const tradeCas = new TradeLifecycleCasService(tradeRepo, auditService);')

session_pg = 'apps/api/src/modules/execution/execution-session.pg-integration.spec.ts'
edit(session_pg,
     '      opening_balance numeric(15,2),\n      peak_equity numeric(15,2),',
     '      opening_balance numeric(15,2),\n      account_currency varchar(3),\n      opening_snapshot_id uuid,\n      opening_snapshot_generation integer,\n      peak_equity numeric(15,2),')
edit(session_pg,
     '      broker_connection_id uuid NOT NULL,\n      authority_generation integer NOT NULL,',
     '      broker_connection_id uuid NOT NULL,\n      credential_generation integer,\n      provider_broker_identity varchar(100),\n      provider_verification_fingerprint varchar(128),\n      risk_profile_id uuid,\n      risk_profile_version integer,\n      risk_profile_hash varchar(64),\n      account_snapshot_id uuid,\n      account_snapshot_generation integer,\n      account_snapshot_observed_at timestamptz,\n      authority_generation integer NOT NULL,\n      kill_switch_generation integer,\n      execution_control_revision integer,\n      authority_binding_digest varchar(64),\n      trading_policy_revision integer,\n      provider_verification_revision integer,')
edit(session_pg,
     '      order_payload jsonb NOT NULL,\n      issued_at timestamptz NOT NULL DEFAULT NOW(),',
     '      order_payload jsonb NOT NULL,\n      quote_ref jsonb,\n      issued_at timestamptz NOT NULL DEFAULT NOW(),')
edit(session_pg,
     '      expires_at timestamptz NOT NULL,\n      invalidated_at timestamptz,',
     '      expires_at timestamptz NOT NULL,\n      consumed_at timestamptz,\n      invalidated_at timestamptz,')
edit(session_pg,
     '      broker_connection_id uuid NOT NULL,\n      order_payload_digest varchar(64) NOT NULL,',
     '      broker_connection_id uuid NOT NULL,\n      risk_grant_id uuid,\n      order_payload_digest varchar(64) NOT NULL,')
edit(session_pg,
     '      quantity numeric(18,8) NOT NULL,\n      expires_at timestamptz NOT NULL,',
     '      quantity numeric(18,8) NOT NULL,\n      stop_loss numeric(18,8),\n      take_profit numeric(18,8),\n      expires_at timestamptz NOT NULL,\n      consumed_at timestamptz,')

auth_pg = 'apps/api/src/modules/broker/authorization/broker-authorization.pg-integration.spec.ts'
edit(auth_pg,
     '        "account_id" varchar(100) NULL,\n        "account_type" varchar(10) NOT NULL DEFAULT \'DEMO\',',
     '        "account_id" varchar(100) NULL,\n        "provider_broker_identity" varchar(100) NULL,\n        "logical_account_key" varchar(255) NULL,\n        "account_type" varchar(10) NOT NULL DEFAULT \'DEMO\',')
edit(auth_pg,
     '        "credential_status" varchar(20) NOT NULL DEFAULT \'CREATED\',\n        "authorized_at" timestamptz NULL,',
     '        "credential_status" varchar(20) NOT NULL DEFAULT \'CREATED\',\n        "credential_generation" integer NOT NULL DEFAULT 0,\n        "credential_refresh_lease_expires_at" timestamptz NULL,\n        "credential_refresh_lease_owner" varchar(64) NULL,\n        "authorized_at" timestamptz NULL,')
edit(auth_pg,
     "    const adapterRegistry = {\n      getAdapter: jest.fn().mockReturnValue(adapter),\n      isSupported: jest.fn().mockReturnValue(true),\n    } as unknown as BrokerAdapterRegistry;",
     "    const adapterRegistry = {\n      getAdapter: jest.fn().mockReturnValue(adapter),\n      getAdapterForConnection: jest.fn().mockReturnValue(adapter),\n      releaseAdapterForConnection: jest.fn(),\n      isSupported: jest.fn().mockReturnValue(true),\n    } as unknown as BrokerAdapterRegistry;")
p = Path(auth_pg)
s = p.read_text()
if 'const tradingAuthority = {' not in s:
    anchor = '    service = new BrokerService(\n'
    block = """    const tradingAuthority = {\n      bumpGeneration: jest.fn().mockResolvedValue(2),\n    };\n    const grantInvalidation = {\n      invalidateUserNewExposureAuthority: jest.fn().mockResolvedValue({\n        invalidatedGrants: 0,\n        revokedConfirmations: 0,\n      }),\n    };\n"""
    if anchor not in s:
        raise SystemExit('BrokerService constructor anchor missing')
    s = s.replace(anchor, block + anchor, 1)
old = """      tokenLifecycle,\n      // Sprint 56 correction round 5 (#332): link outbox — unused by the\n      // authorization-transition paths under test.\n      // Round 6 (#300): the unified authority seams — unused by the\n      // authorization-transition paths under test (CI-gated suite).\n      {} as never,\n      {} as never,\n      // Round 6 live-execution completion (§1a): snapshot authority seam —\n      // unused by the authorization-transition paths under test.\n      {} as never,\n      {} as never,\n"""
new = """      tokenLifecycle,\n      // Sprint 56 correction round 5 (#332): link outbox — unused by the\n      // authorization-transition paths under test.\n      {} as never,\n      tradingAuthority as never,\n      grantInvalidation as never,\n      // Round 6 live-execution completion (§1a): snapshot authority seam —\n      // unused by the authorization-transition paths under test.\n      {} as never,\n"""
if new not in s:
    if old not in s:
        raise SystemExit('BrokerService seam argument anchor missing')
    s = s.replace(old, new, 1)
p.write_text(s)
