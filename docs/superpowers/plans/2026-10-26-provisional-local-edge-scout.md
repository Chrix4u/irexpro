# Provisional Local-Edge PAPER Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Let emerging exact M5 local-edge pockets earn a micro PAPER probe without weakening global safety gates.

**Architecture:** Extend local-pocket evidence with a provisional predicate, teach the opportunity scout to admit only strict current-market candidates, and allow that micro scout to override only the broad realised-continuation veto. Keep all downstream safety unchanged.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL evidence store.

**Spec:** `docs/superpowers/designs/2026-10-26-provisional-local-edge-scout.md`

## Global Constraints
- PAPER only.
- 0.10 lot maximum.
- No DEMO/LIVE authority changes.
- No OOD provisional rescue.
- No confirmed reversal authority.
- Preserve post-loss, entry alignment, event, portfolio, margin, SL/TP and broker controls.

### Task 1: Provisional local-pocket predicate
- [x] Add RED tests for 3/3 recent strong pocket and fail-closed cases.
- [x] Implement predicate and verify GREEN (38/38 combined pocket/scout tests).

### Task 2: Scout admission
- [x] Add RED scout tests for strict current positive economics and OOD/event vetoes.
- [x] Implement provisional scout reason at 0.10 lot and verify GREEN.

### Task 3: Broad-route micro override
- [x] Add RED helper tests proving provisional local scout can bypass only the broad realised-route veto.
- [x] Implement wiring and model-version update; focused authority tests 6/6 GREEN.
- [x] Run focused trading suites and static checks; push PR and exact-head CI next.
