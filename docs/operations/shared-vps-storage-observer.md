# Shared Lightworld VPS storage observer

**Installed 2026-11-21 on vps.lightworldtech.com** in response to shared
server disk growth. This observer is strictly **read only**. It does not
modify deployments, remove files, contact a broker, perform backups or publish
project storage to the internet.

## Metrics, cadence and protections

The executable `/usr/local/sbin/lightworld-storage-watch` is mirrored in
`scripts/deployment/shared-vps-storage-watch.py`. An installed systemd
`lightworld-vps-storage-watch.timer` samples root block availability,
df-compatible percentage, inode usage and a sanitized count of active build
tools every **30 minutes**. Time-stamped JSON snapshots are kept under
`/var/lib/lightworld-storage-watch/snapshots`; only the last **336**
snapshots are retained. Files and parent directories are root-only.

The monitor logs to system journal/syslog with the
`lightworld-storage-watch` tag when:

- root filesystem usage is **90% or higher**;
- free disk space is **30 GiB or less**;
- disk usage rises by at least **2 GiB** between samples no more than four
  hours apart.

A separate `lightworld-vps-storage-inventory.timer` schedules a **nightly
low-I/O**, 15-minute maximum directory size survey at **03:30 UTC** with a
random delay up to 30 minutes. It scans only the first-level directories under
`/home/lightworld`, records *sizes only*, refuses to run when a known build
is active, uses idle I/O and CPU quota and stores its last successful result
in `/var/lib/lightworld-storage-watch/inventory.json`. The data is evidence
for **manual analysis**, not authority to delete any directory.

Both timers run without changing PM2/Nginx, trading state, credentials,
payments or application code. They do **not** send ChatGPT push notifications
or automatically block arbitrary commands. The separate
`lightworld-vps-capacity-check build` must still be explicitly invoked
as a preflight to block discretionary VPS builds.

## Operational commands

```bash
/usr/local/sbin/lightworld-storage-watch status
/usr/local/sbin/lightworld-storage-watch collect
# Only when other build processes are idle; can take several minutes:
/usr/local/sbin/lightworld-storage-watch inventory
systemctl list-timers --all | grep lightworld-vps-storage
journalctl -t lightworld-storage-watch --no-pager -n 30
```

Never expose `/var/lib/lightworld-storage-watch` directly on a public web
server. The size report covers multiple projects with different owners and
retention requirements. It is not safe to clean them by common path pattern
without checking immutable release provenance, current & previous symlinks,
current process/open-file usage, finance/data dependencies, backup integrity
and project-specific retention consent.

## Deployment status

As of installation the VPS was approximately **90% used, with 33.26 GiB
available**, still above the operational goal of **80% or lower**. The
iRexPro GitHub-built standalone trial remains **not** switched into active
API/AI operation; broker/state reconciliation gates still apply.

The monitor's five Python regression tests cover current-stat sanity, atomic
JSON snapshots, 336-sample retention, malformed JSON handling and active
build-count validity. They run on the project Deployment Script Safety CI.
