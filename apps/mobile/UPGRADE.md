# iRexPro Mobile — Expo SDK Modernization Plan

The mobile app is being advanced from the merged Expo SDK 54 + React Native New Architecture baseline to Expo SDK 55. The current stable Expo line is SDK 57, so modernization remains incremental rather than a multi-major dependency jump.

## Governing rule

Upgrade one Expo SDK at a time and require the complete exact-head mobile release gate after every step:

1. SDK 51 → 52 — completed
2. SDK 52 → 53 — completed
3. SDK 53 → 54 — completed
4. React Native New Architecture on SDK 54 — completed
5. SDK 54 → 55 — current checkpoint
6. SDK 55 → 56
7. SDK 56 → 57

Each checkpoint must be a separate pull request. Do not stack the next SDK change until the preceding checkpoint is merged into `main` and its exact combined state is green.

## Required validation for every SDK step

From a clean frozen-lock install, every candidate must pass:

- `pnpm dlx expo-doctor@latest`
- `expo install --check` — immutable Expo dependency-alignment validation
- `pnpm --filter @irexpro/mobile validate:release-config`
- `pnpm --filter @irexpro/mobile typecheck`
- Android Metro export
- iOS Metro export
- Web and Admin production builds when the root dependency graph changes
- disposable Android/iOS native generation where the SDK checkpoint changes native configuration
- Release Security and every other workflow selected by the exact-head path matrix
- Required CI Gate

When dependency versions change, regenerate `pnpm-lock.yaml` with pnpm/Expo tooling rather than hand-editing resolved dependency graphs. Run Expo's dependency fixer for the target SDK, then review every package change before committing it.

## Completed New Architecture checkpoint on SDK 54

Sprint 53 enabled React Native New Architecture before the SDK 55 dependency upgrade. It also removed the SDK-51-era custom Metro monorepo overrides and forced pnpm hoisting after a dedicated compatibility probe demonstrated that Expo SDK 54 works correctly with Expo's default Metro configuration and pnpm's isolated dependency layout.

The accepted SDK 54 baseline:

- uses Expo's default `getDefaultConfig(__dirname)` Metro configuration
- uses pnpm's isolated dependency layout
- does not contain a Legacy Architecture opt-out
- keeps root/web/admin React and ReactDOM isolated from the mobile React runtime
- passed Expo Doctor, dependency alignment, mobile TypeScript, Android/iOS Metro exports, Web/Admin production builds, disposable native generation, and all exact-head repository gates

## SDK 55 checkpoint

Expo SDK 55 makes React Native New Architecture mandatory and removes the `newArchEnabled` app-config option. The SDK 55 dependency graph is materialized with Expo tooling rather than by hand.

Current Expo-aligned mobile runtime for this checkpoint:

- Expo `~55.0.31`
- React Native `0.83.10`
- React `19.2.0`
- Expo SecureStore `~55.0.18`
- Expo System UI `~55.0.22`
- React Native Safe Area Context `~5.6.2`
- React types `~19.2.17`
- TypeScript `~5.9.3`

Additional SDK 55 rules:

1. `newArchEnabled` must remain absent because SDK 55 no longer supports a Legacy Architecture switch.
2. `expo-system-ui` is installed and registered as a config plugin so the app's global dark `userInterfaceStyle` is applied on Android.
3. Hermes remains the normal Expo/React Native JavaScript engine, but the separate Hermes v1 opt-in is deliberately not enabled in this SDK 55 checkpoint.
4. The Expo default Metro configuration and pnpm isolated workspace layout proven in Sprint 53 remain unchanged.
5. Expo Doctor must pass or every warning must be explicitly dispositioned.
6. Root/web/admin/mobile React runtime resolution must be proven after the lockfile change.
7. Android and iOS Metro exports must pass.
8. Web and Admin production builds must pass.
9. Disposable `expo prebuild --platform all --no-install --clean` must succeed and must not leave tracked source mutations after cleanup.
10. Native-generation evidence may verify generated New Architecture and Android platform configuration, but Linux CI does not replace an Xcode 26 native iOS compilation or signed EAS build.
11. No Expo/EAS project ID, Apple credential, Android signing key, or other release secret may be invented or committed.

## Remaining SDK checkpoints

After SDK 55 is merged and its exact combined state is green, continue in order: SDK 55 → 56, then SDK 56 → 57. Read each release's current migration notes before changing dependencies because minimum tooling and platform requirements can advance between releases.

Do not remove compatibility workarounds merely because a newer SDK supports a cleaner default. Remove each workaround only in the checkpoint where CI/build evidence proves the default replacement works in this monorepo.

## EAS/native proof boundary

Metro export proves JavaScript bundling and module resolution; it does not replace signed native-build evidence. Disposable `expo prebuild` output can prove generated architecture/configuration state, but store-grade native proof still requires authorized EAS project linkage and platform signing credentials.

Once an authorized operator links the app to its EAS project and configures platform credentials, preview native builds for both Android and iOS must be added to the release evidence before store release. SDK 55 native iOS compilation requires the SDK-appropriate Xcode 26 toolchain; Linux CI cannot prove that compile step.

No Expo/EAS account tokens, Apple credentials, Android signing keys, or backend secrets belong in this repository.
