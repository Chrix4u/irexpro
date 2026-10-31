# iRexPro Mobile Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a durable Android preview release, expose it in web onboarding, and prepare fail-closed iOS/TestFlight automation.

**Architecture:** Extend the proven Android preview workflow so release tags publish named APK/checksum assets, then link that exact release from the web onboarding. Add a separate EAS iOS workflow that requires operator-supplied Expo authentication and preserves remote signing credentials.

**Tech Stack:** GitHub Actions, Expo/EAS, React/Next.js, React Native, pnpm/Jest.

**Spec:** `docs/superpowers/designs/2026-10-31-mobile-distribution.md`

## Global Constraints
- No API, AI, broker-execution, risk, or LIVE-certification changes.
- Android preview continues to target `https://irexpro.lightworldtech.com/api/v1`.
- No signing credentials or access tokens committed.
- Durable Android release assets are published only from `irexpro-mobile-v*` tags.

## Review Focus
- Branch pushes must never create GitHub Releases.
- Tag builds must publish the exact APK produced by the validated SHA.
- Web copy must clearly distinguish Android iRexPro app from the Windows MT5 execution bridge.
- Missing Expo auth must fail iOS workflow before build/submit.
- Existing Direct MT5 LIVE lock must remain unchanged.

---

### Task 1: Durable Android preview release
**Files:** `.github/workflows/mobile-apk.yml`, `apps/mobile/scripts/test-mobile-apk-workflow.cjs`
- [ ] Add failing workflow contract tests for release tag trigger, stable asset names, and tag-only GitHub Release publishing.
- [ ] Verify RED.
- [ ] Implement release-tag build/publish while retaining branch artifact behavior.
- [ ] Verify mobile workflow/full mobile tests GREEN.
- [ ] Commit.

### Task 2: Web portal mobile download handoff
**Files:** `apps/web/src/app/onboarding/broker/page.tsx`, `apps/web/src/app/onboarding/broker/direct-mt5-onboarding.spec.tsx`
- [ ] Add failing tests for Android preview download and Windows-bridge distinction.
- [ ] Verify RED.
- [ ] Add the exact durable release link and explanatory copy.
- [ ] Run focused/full web tests, typecheck, build.
- [ ] Commit.

### Task 3: iOS/TestFlight readiness
**Files:** `.github/workflows/mobile-ios-testflight.yml`, `apps/mobile/scripts/test-mobile-ios-workflow.cjs`, `apps/mobile/package.json`, `apps/mobile/RELEASE.md`
- [ ] Add failing static contract test requiring Expo auth gate, preview EAS iOS build, artifact/build URL evidence, and no embedded secret.
- [ ] Verify RED.
- [ ] Add fail-closed TestFlight preparation workflow and docs/scripts.
- [ ] Run mobile tests/typecheck and YAML parse.
- [ ] Commit.

### Task 4: Integration and publication
- [ ] Run web + mobile complete verification and diff/security scope check.
- [ ] Cherry-pick verified commits to `deploy/daily-loss-reset-20261028` if base is unchanged.
- [ ] Re-run critical merged-tree gates.
- [ ] Push deployment branch and restart web only.
- [ ] Tag exact deployed commit `irexpro-mobile-v0.1.5-preview.1`.
- [ ] Verify tagged Android workflow succeeds and durable release contains APK + checksum.
- [ ] Verify web/API health and release asset availability.
