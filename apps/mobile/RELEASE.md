# iRexPro Mobile Release Engineering

This document covers repository-owned release configuration for the Expo mobile app. It does not contain credentials and does not make the repository appear linked to EAS before an authorized operator actually links it.

## Repository state

- Expo project: `apps/mobile`
- iOS bundle identifier: `com.irexpro.mobile`
- Android package: `com.irexpro.mobile`
- App semantic version: `expo.version` in `app.json`
- Platform build numbers: initialized in `app.json`, then managed remotely by EAS
- Production build-number policy: `cli.appVersionSource=remote` and `production.autoIncrement=true`
- Production Android artifact: Android App Bundle (`.aab`)
- Signing credential source: EAS remote credentials
- Preview/staging API base URL: `https://irexpro.lightworldtech.com/api/v1`
- Production API base URL: intentionally externalized to the EAS `production` environment and must use a distinct production hostname

`eas.json` defines three release-facing profiles:

| Profile | Distribution | App environment | Intended use |
| --- | --- | --- | --- |
| `development` | internal | `development` | authorized internal development/QA install |
| `preview` | internal | `staging` | production-like stakeholder validation |
| `production` | store | `production` | App Store / Google Play release artifact |

The development profile intentionally does not enable `developmentClient`; the repository does not currently depend on `expo-dev-client`. This keeps the build profile truthful and avoids declaring a native dependency that is not installed.

## Source validation

From the repository root:

```bash
pnpm --filter @irexpro/mobile validate:release-config
```

This is the CI-safe validation mode. It verifies profile structure, stable package identifiers, version seeds, preview/staging API configuration, public-only build environment values, and EAS project metadata if present. The production API URL is intentionally not committed; strict release preflight validates the runtime value supplied by the EAS production environment.

An absent `extra.eas.projectId` is accepted in source validation because it means the repository is explicitly **not linked yet**. An empty, placeholder, or malformed project ID is rejected.

## One-time authorized EAS linkage

Project linkage is account-owned and must be performed by an authorized Expo/EAS operator. From `apps/mobile`, using an authenticated EAS CLI session:

```bash
eas init
```

Choose the intended organization/account and the correct EAS project. `eas init` writes the EAS project UUID to `app.json` under:

```json
{
  "expo": {
    "extra": {
      "eas": {
        "projectId": "<generated-eas-project-uuid>"
      }
    }
  }
}
```

Do not commit Expo access tokens, session credentials, signing secrets, Apple credentials, Google service-account keys, or backend secrets. Only the non-secret EAS project UUID belongs in repository configuration.

After linkage, configure `EXPO_PUBLIC_API_BASE_URL` in the authorized EAS **production environment** to the real production API endpoint. It must be an absolute HTTPS URL and must not use the staging hostname `irexpro.lightworldtech.com`.

Then run the strict preflight with the same production runtime value available to the process:

```bash
EXPO_PUBLIC_API_BASE_URL=https://api.<production-domain>/api/v1 \
  pnpm --filter @irexpro/mobile release:preflight
```

This command fails unless `extra.eas.projectId` is a valid UUID, the production API is distinct from staging, and all source-level release requirements still pass.

## Build commands

Run EAS build commands from `apps/mobile` after project linkage and signing credentials are configured for the authorized EAS project.

Preview builds:

```bash
eas build --platform android --profile preview
eas build --platform ios --profile preview
```

Production builds:

```bash
eas build --platform android --profile production
eas build --platform ios --profile production
```

The `production` profile uses remote platform version management and auto-increments the store build number. `expo.version` remains the human-facing semantic app version and should be intentionally changed for product releases.

## Release safety properties

- No backend-only secret is allowed in committed EAS profile `env` values.
- Production API configuration must use HTTPS and cannot target localhost.
- Stable iOS/Android application identifiers are validated in CI.
- Production Android builds explicitly use `.aab` format.
- A missing EAS project ID is represented by absence, not an empty string.
- A malformed or placeholder project ID fails validation.
- Actual cloud build/signing remains impossible until an authorized operator links the project and configures EAS-managed platform credentials.
