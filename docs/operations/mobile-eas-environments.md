# Mobile EAS environment isolation

This runbook defines the release boundary for the iRexPro Expo/EAS mobile application.

## Environment contract

| EAS build profile | EAS environment | App environment | API source |
|---|---|---|---|
| `development` | `development` | `development` | committed public development/staging API URL |
| `preview` | `preview` | `staging` | committed verified staging API URL |
| `production` | `production` | `production` | `EXPO_PUBLIC_API_BASE_URL` from the EAS production environment |

The verified staging public API is currently:

`https://irexpro.lightworldtech.com/api/v1`

The repository's Nginx staging topology maps that URL to the staging NestJS process on `127.0.0.1:3010`. It must therefore not be treated as the production mobile API.

## Production API requirement

Before any store/production EAS build, configure a plain-text project environment variable named:

`EXPO_PUBLIC_API_BASE_URL`

in the EAS **production** environment. It must point to the dedicated production HTTPS API endpoint and must use a hostname different from `irexpro.lightworldtech.com`.

`EXPO_PUBLIC_` values are embedded in the client application and are not secrets. Never store broker credentials, provider tokens, signing material, database credentials, or backend-only secrets under an `EXPO_PUBLIC_` name.

## Fail-closed checks

`apps/mobile/scripts/validate-release-config.cjs` enforces all of the following:

- `preview` is bound to the EAS `preview` environment;
- `production` is bound to the EAS `production` environment;
- the shared `base` profile cannot define `EXPO_PUBLIC_API_BASE_URL`;
- the production profile cannot commit an API URL that would override its EAS production environment;
- preview resolves to the verified staging API;
- a production runtime API must be absolute HTTPS and non-local;
- a production runtime API cannot equal the staging URL or use the staging hostname.

EAS cloud builds execute the same validator through the `eas-build-pre-install` lifecycle hook. A production build therefore fails before dependency installation if its environment has no valid distinct production API URL.

## Operator preflight

After linking the Expo project with the authorized Expo account and configuring the production environment variable, run from the repository root:

```bash
pnpm --filter @irexpro/mobile release:preflight
```

For a local preflight, `EXPO_PUBLIC_API_BASE_URL` must be present in the command environment and must contain the production API URL. Do not place the production URL in `apps/mobile/eas.json`; keeping it in the EAS production environment prevents accidental preview/production aliasing.

## Preview/UAT

Preview builds remain intentionally connected to the verified staging API. They are suitable for staging UAT only and must not be used as evidence that the production API, production broker connectivity, or production-LIVE provider eligibility has been certified.
