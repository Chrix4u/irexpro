# iRexPro Mobile Distribution Design

## Goal
Make the newly verified Direct MT5 mobile flow easy to install and test: publish a durable Android preview release, expose that release from the web portal, and prepare a truthful iOS/TestFlight automation path without weakening signing or trading gates.

## Decisions
- Android preview release tag: `irexpro-mobile-v0.1.5-preview.1`, matching `expo.version=0.1.5`.
- Android release assets: `iRexPro-Android-Preview.apk` and `SHA256SUMS.txt`.
- Reuse the already proven native Android CI build steps. Branch pushes remain ephemeral artifacts; only `irexpro-mobile-v*` tags publish durable GitHub Release assets.
- The web broker onboarding exposes the Android preview download as a test-build convenience, clearly labelled preview/staging. The existing Windows connector remains a separate required bridge for Direct MT5 execution.
- iOS uses EAS preview/TestFlight preparation. The workflow requires an authorized `EXPO_TOKEN`; absent auth fails before any build/submission. No Apple/Expo secret is committed.
- Do not modify API, broker execution, AI models, risk controls, or Direct MT5 LIVE certification.

## Safety
- Android APK is a preview/staging build pointed at the staging API.
- LIVE Direct MT5 remains controlled solely by existing server certification evidence.
- iOS automation must not claim publication until EAS authentication and Apple signing actually succeed.
