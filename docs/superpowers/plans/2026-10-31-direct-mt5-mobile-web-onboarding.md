# Direct MT5 Mobile/Web Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Direct MT5 onboarding clearly phone/web-first with two explicit Windows bridge paths.

**Architecture:** Extend the existing web Direct MT5 block and add a specialized Direct MT5 branch to the native mobile `BrokerScreen`. Reuse the shared API client pairing/health/revoke endpoints and the same registry-backed LIVE gate. Keep all server-side LIVE certification and connector security behavior untouched.

**Tech Stack:** Next.js 15, React, Expo/React Native, TypeScript, Jest, Testing Library.

**Spec:** `docs/superpowers/designs/2026-10-31-direct-mt5-mobile-web-onboarding.md`

## Global Constraints
- Do not modify API, connector protocol, or broker execution code.
- Direct MT5 LIVE remains locked unless existing server certification reports `CERTIFIED`.
- MetaAPI remains optional.
- Layout must remain mobile responsive.

## Review Focus
- User understands phone/web remains the main control surface.
- Existing-Windows path preserves installer and pairing controls.
- Need-Windows path provides setup guidance without creating a broker connection.
- Switching between paths does not reset LIVE certification state.
- MetaAPI switching still works.

---

### Task 1: Phone/Web-first Direct MT5 onboarding

**Files:**
- Modify: `apps/web/src/app/onboarding/broker/page.tsx`
- Test: `apps/web/src/app/onboarding/broker/direct-mt5-onboarding.spec.tsx`

**Interfaces:**
- Consumes: existing Direct MT5 registry certification state, installer URL, pairing form.
- Produces: local onboarding bridge-path state and two user-facing branches.

- [ ] Add failing tests for phone/web-first copy and the two Windows bridge choices.
- [ ] Run focused test and confirm RED.
- [ ] Implement responsive choice controls and setup guidance.
- [ ] Run focused test and confirm GREEN.
- [ ] Run full web tests, typecheck, and production build.
- [ ] Commit.

### Task 2: Native mobile Direct MT5 pairing

**Files:**
- Modify: `apps/mobile/src/screens/broker-screen.logic.ts`
- Modify: `apps/mobile/src/screens/BrokerScreen.tsx`
- Test: `apps/mobile/src/screens/__tests__/broker-screen.logic.test.ts`

**Interfaces:**
- Consumes: shared `ApiClient.createDirectMt5Pairing`, `getDirectMt5ConnectionHealth`, `revokeDirectMt5Connector`; server registry `CERTIFIED` state.
- Produces: mobile Direct MT5 connection/pairing flow with the same two Windows bridge choices.

- [ ] Add failing pure-logic tests for Direct MT5 request validation and fail-closed LIVE gating.
- [ ] Run mobile focused test and confirm RED.
- [ ] Implement the Direct MT5 request helper and use it from the native mobile flow.
- [ ] Add mobile pairing, pairing-code, health, regenerate, revoke, installer guidance, and Windows/VPS setup views.
- [ ] Run mobile tests and typecheck.
- [ ] Re-run web regression/build and mobile regression/typecheck.
- [ ] Commit.
