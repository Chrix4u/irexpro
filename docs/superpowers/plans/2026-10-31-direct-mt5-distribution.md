# Direct MT5 Windows Distribution & Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows-friendly Direct MT5 connector and make broker onboarding accurately guide DEMO use and certification-locked LIVE use.

**Architecture:** Reuse the existing connector client/terminal/journal protocol. Extract a reusable connector runtime, place a Tkinter desktop UI on top, package it on a Windows GitHub Actions runner, and update Next.js onboarding to expose download/upgrade and LIVE-lock state without weakening API gates.

**Tech Stack:** Python 3.11, Tkinter, PyInstaller, GitHub Actions Windows runner, Next.js/React/Jest.

**Spec:** `docs/superpowers/designs/2026-10-31-direct-mt5-distribution.md`

## Global Constraints
- Direct MT5 protocol v2 remains authoritative.
- LIVE stays fail-closed until current certification evidence exists.
- No MT5 passwords are stored or requested.
- MetaAPI remains optional.

## Review Focus
- GUI stop/restart does not duplicate an in-flight MT5 mutation.
- Missing/legacy config requires re-pair rather than guessing account environment.
- Windows bundle includes MetaTrader5/keyring runtime dependencies.
- Onboarding never enables LIVE from catalog environment support alone.
- Download copy does not point users to a nonexistent local server path.

---

### Task 1: Reusable connector runtime + desktop UI
**Files:**
- Create: `services/mt5-connector/irexpro_mt5_connector/runtime.py`
- Create: `services/mt5-connector/irexpro_mt5_connector/gui.py`
- Modify: `services/mt5-connector/irexpro_mt5_connector/main.py`
- Test: `services/mt5-connector/tests/test_gui_runtime.py`

- [ ] Write failing tests for pair/run lifecycle, stop signal, legacy config refusal, and safe status callbacks.
- [ ] Run tests and confirm RED.
- [ ] Extract reusable runtime and implement Tkinter launcher.
- [ ] Run connector tests and confirm GREEN.
- [ ] Commit.

### Task 2: Windows packaging/release workflow
**Files:**
- Create: `services/mt5-connector/packaging/irexpro-mt5-connector.spec`
- Create: `services/mt5-connector/packaging/installer.iss`
- Create: `.github/workflows/mt5-connector-windows-release.yml`
- Modify: `services/mt5-connector/README.md`

- [ ] Add packaging validation tests/static checks.
- [ ] Add PyInstaller spec and Inno Setup installer definition.
- [ ] Add tagged-release Windows build workflow and checksums.
- [ ] Verify workflow YAML and Python import/build inputs locally where possible.
- [ ] Commit.

### Task 3: Accurate Direct MT5 onboarding
**Files:**
- Modify: `apps/web/src/app/onboarding/broker/page.tsx`
- Modify: `apps/web/src/app/onboarding/broker/direct-mt5-onboarding.spec.tsx`
- Modify: `apps/web/e2e/fixtures.ts` if required.

- [ ] Write failing UI tests for connector download/upgrade copy and LIVE certification lock.
- [ ] Run tests and confirm RED.
- [ ] Add DEMO/LIVE choice presentation; keep LIVE disabled unless server registry reports current CERTIFIED state; add stable Windows download link and v1 re-pair notice.
- [ ] Run web tests/build and confirm GREEN.
- [ ] Commit.

### Task 4: Integration, deploy, release trigger
- [ ] Run Python connector suite, focused web tests, web build, and relevant API registry tests.
- [ ] Self-review diff for LIVE-gate bypasses and secret handling.
- [ ] Cherry-pick to deployment branch after green verification.
- [ ] Build/restart web only as needed and health-check.
- [ ] Push branch/tag that triggers the Windows release workflow; verify release job state if repository tooling allows.
