# Direct MT5 Mobile/Web Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Direct MT5 onboarding clearly phone/web-first with two explicit Windows bridge paths.

**Architecture:** Extend the existing `apps/web/src/app/onboarding/broker/page.tsx` Direct MT5 block. Keep all server-side LIVE certification and connector security behavior untouched. Pin behavior in `direct-mt5-onboarding.spec.tsx`.

**Tech Stack:** Next.js 15, React, TypeScript, Jest, Testing Library.

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
