# Direct MT5 Always-On Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Direct MT5 reliably unattended on a personal Windows PC or always-on Windows VPS, with VPS recommended for 24/5 execution.

**Architecture:** Keep one protocol-v2 connector binary. Add a supervised retry loop, Windows autostart/background/tray behavior, persist a connector host mode through pairing, and expose that choice/status in onboarding.

**Tech Stack:** Python 3.11, Tkinter, pystray/Pillow on Windows, PyInstaller/Inno Setup, NestJS/TypeScript/PostgreSQL, Next.js/React/Jest.

**Spec:** `docs/superpowers/specs/2026-11-01-direct-mt5-always-on-hosting-design.md`

## Global Constraints
- Never store the MT5/broker password in iRexPro.
- Preserve Direct MT5 protocol-v2 identity binding and exactly-once journal behavior.
- Do not run MT5 as a Windows Service; run in the signed-in Windows user session.
- Fatal identity/auth/protocol errors fail closed; only transient availability failures retry.
- `WINDOWS_VPS` means a user-controlled Windows VPS; vendor provisioning is outside this release.

## Review Focus
- Connector loses internet while a command result is being reported: no blind command replay after restart.
- MT5 terminal closes/reopens: connector retries availability but revalidates bound identity before leasing commands.
- Connector token is revoked: supervisor must stop rather than loop forever.
- Windows startup launches before pairing exists: background process must not create unsafe execution or noisy failure loops.
- Host-mode input outside PERSONAL_PC/WINDOWS_VPS: API must reject it.

---

### Task 1: Supervised connector runtime and Windows background lifecycle

**Files:**
- Modify: `services/mt5-connector/irexpro_mt5_connector/runtime.py`
- Create: `services/mt5-connector/irexpro_mt5_connector/windows.py`
- Modify: `services/mt5-connector/irexpro_mt5_connector/gui.py`
- Modify: `services/mt5-connector/irexpro_mt5_connector/config.py`
- Test: `services/mt5-connector/tests/test_gui_runtime.py`
- Test: `services/mt5-connector/tests/test_config_and_dispatch.py`

**Interfaces:**
- Produces: `run_supervised_connector(...) -> int`, `set_windows_autostart(enabled: bool)`, connector settings `auto_start` and `start_minimized`.

- [ ] Add failing tests for transient reconnect, fatal connector error stop, settings backward compatibility, and Windows autostart command.
- [ ] Run targeted tests and confirm RED.
- [ ] Implement bounded reconnect supervision (1s doubling to 30s, reset after READY) while preserving `run_connector` journal semantics.
- [ ] Add Windows HKCU Run autostart helper and GUI controls.
- [ ] Add system-tray/background close behavior and explicit Exit; paired startup auto-runs connector.
- [ ] Run connector tests and confirm GREEN.
- [ ] Commit.

### Task 2: Windows packaging and startup contract

**Files:**
- Modify: `services/mt5-connector/pyproject.toml`
- Modify: `services/mt5-connector/packaging/installer.iss`
- Modify: `services/mt5-connector/README.md`
- Modify: `services/mt5-connector/tests/test_packaging_contract.py`

**Interfaces:**
- Consumes: background CLI/startup behavior from Task 1.
- Produces: v0.3.0 installer with default start-at-login task and tray dependencies.

- [ ] Add failing packaging assertions for v0.3.0, autostart registry entry, and `--background` startup argument.
- [ ] Run packaging test and confirm RED.
- [ ] Update dependencies/version/installer/docs.
- [ ] Run all connector tests and packaging probe.
- [ ] Commit.

### Task 3: Persist connector execution host mode

**Files:**
- Create: `apps/api/src/database/migrations/1793510000000-AddDirectMt5ConnectorHostMode.ts`
- Modify: `apps/api/src/modules/broker/direct-mt5/direct-mt5-pairing.service.ts`
- Modify: `apps/api/src/modules/broker/direct-mt5/direct-mt5-connector.controller.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/api-client/src/index.ts`
- Test: `apps/api/src/modules/broker/direct-mt5/direct-mt5-pairing.service.spec.ts`
- Test: `apps/api/src/modules/broker/direct-mt5/direct-mt5-connector.controller.spec.ts`

**Interfaces:**
- Produces: `DirectMt5ConnectorHostMode = 'PERSONAL_PC' | 'WINDOWS_VPS'`; pairing request accepts hostMode; health returns hostMode.

- [ ] Add failing API/service tests for WINDOWS_VPS persistence, PERSONAL_PC default, health projection, and invalid mode rejection.
- [ ] Run targeted API tests and confirm RED.
- [ ] Add migration, DTO validation, service SQL, shared types, and API-client request shape.
- [ ] Run targeted API/types tests and confirm GREEN.
- [ ] Commit.

### Task 4: VPS-first onboarding UX

**Files:**
- Modify: `apps/web/src/app/onboarding/broker/page.tsx`
- Modify: `apps/web/src/app/onboarding/broker/direct-mt5-onboarding.spec.tsx`

**Interfaces:**
- Consumes: hostMode pairing API from Task 3.
- Produces: explicit Personal Windows vs Always-on Windows VPS choice; v0.3.0 connector download; host-mode status copy.

- [ ] Add failing UI tests for VPS recommendation, hostMode request, and corrected v0.3.0 installer URL.
- [ ] Run focused web test and confirm RED.
- [ ] Implement the VPS-first choice and explanatory copy; pass selected hostMode when generating pairing.
- [ ] Run focused web test and broader relevant web/API suites.
- [ ] Commit.

### Task 5: Final verification and release readiness

**Files:** none except fixes required by verification.

- [ ] Run connector Python suite, API direct-MT5 suites, web direct-MT5 onboarding suite, typecheck/build checks, and `git diff --check`.
- [ ] Review full diff against the design safety constraints.
- [ ] Publish feature branch/PR only after all checks pass; Windows release CI must build before tagging v0.3.0.
