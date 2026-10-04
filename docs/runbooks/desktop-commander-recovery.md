# Desktop Commander VPS Recovery

The staging VPS keeps Desktop Commander under systemd and persists the authenticated
device session at `/root/.desktop-commander-device/device.json`.

## Normal operation

- Service: `desktop-commander.service`
- Watchdog: `desktop-commander-watchdog.timer`
- Recovery helper: `/usr/local/sbin/dc-recovery`
- Account switch helper: `/usr/local/sbin/dc-switch-user`
- Account switch unit: `desktop-commander-account-switch.service`

The watchdog checks the service every two minutes and starts it if it is inactive.

## Fixed recovery actions

The GitHub Actions workflow **Desktop Commander Recovery** intentionally accepts
only four actions:

- `status`: report service/watchdog state and the persisted device ID.
- `restart`: restart Desktop Commander using the currently persisted account.
- `repair`: reload systemd, re-enable the service/watchdog, and restart both.
- `switch-account`: start the account-switch service. The workflow prints only
  the verification URL/code lines needed to authorize the new Desktop Commander
  account. After authorization, the VPS helper automatically hands the new session
  back to the persistent systemd service.

No arbitrary remote command input is accepted by the workflow.

## Recommended account-switch sequence

When Desktop Commander is still reachable, ask ChatGPT to switch the VPS account
before changing the Desktop Commander connector. ChatGPT can start the account
switch helper and the user only completes the provider authorization step.

If Desktop Commander is already unreachable, run **Desktop Commander Recovery**
from GitHub Actions with `switch-account`, complete the printed authorization,
then run `status` if verification is needed.
