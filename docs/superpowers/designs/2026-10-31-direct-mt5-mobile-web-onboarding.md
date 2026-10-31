# Direct MT5 Mobile/Web Onboarding Design

## Goal
Make iRexPro mobile/web the clearly primary control surface while explaining that Direct MT5 execution requires a one-time Windows PC/VPS bridge running the MT5 desktop terminal.

## Approved UX
- Lead with: users can set up and control iRexPro from phone or web.
- Explain Windows is only the Direct MT5 execution bridge and does not need to be the day-to-day control surface.
- Offer two explicit choices:
  1. “I already have MT5 running on a Windows PC/VPS” → proceed to installer/pairing.
  2. “I need a Windows PC/VPS for MT5” → show setup guidance before pairing.
- Keep Direct MT5 DEMO available.
- Keep Direct MT5 LIVE certification gating unchanged and fail-closed.
- Keep MetaAPI optional.

## Scope
Modify both the web broker onboarding and the native Expo mobile Broker screen so Android/iPhone users can create Direct MT5 connections and pairing codes themselves. Reuse the shared API client's existing Direct MT5 pairing/health/revoke endpoints. Do not change API broker execution, pairing protocol, certification logic, or connector runtime.
