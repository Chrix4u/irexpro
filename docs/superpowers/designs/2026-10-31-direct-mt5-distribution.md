# Direct MT5 Windows Distribution & Onboarding Design

## Intent
Make the newly deployed native Direct MT5 route usable by an ordinary iRexPro user without Python/terminal setup, while keeping production LIVE fail-closed until a real-money certification artifact is attested.

## Approach
1. Keep the existing connector protocol and execution engine unchanged.
2. Add a Windows desktop launcher around the existing connector core using Tkinter; it pairs the currently logged-in MT5 terminal, stores secrets in Windows keyring, and runs/stops the connector loop visibly.
3. Package the launcher as a PyInstaller Windows executable and create a GitHub Actions Windows release workflow that publishes a versioned ZIP/installer artifact.
4. Update broker onboarding so Direct MT5 clearly exposes DEMO and LIVE capability truth. DEMO can be created normally. LIVE remains visibly locked while `certificationState !== CERTIFIED` / `productionLiveVerification` is not current-certified; no UI bypass is added.
5. Add a stable download link and upgrade notice. Protocol-v1 connector users are told to install the current connector and re-pair.

## Non-goals
- Do not auto-certify LIVE.
- Do not store MT5 passwords or broker secrets.
- Do not remove MetaAPI; it remains optional.
- Do not bypass server-side LIVE eligibility checks.

## Safety constraints
- GUI uses the same identity/environment checks as the CLI.
- Closing the GUI stops the poll loop cleanly.
- Old connector configs lacking protocol-v2 account type fail closed and require re-pairing.
- The web UI must never imply LIVE is available merely because `environments` contains LIVE.
