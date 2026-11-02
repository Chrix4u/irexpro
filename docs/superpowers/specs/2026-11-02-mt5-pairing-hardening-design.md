# Direct MT5 Pairing Hardening Design

## Intent
A valid pairing code must never be consumed while the Windows connector fails to retain connector identity/token or the broker connection remains half-paired.

## Chosen approach
- Make server redemption atomic across connector activation and broker-connection update.
- Pin the successful API contract with tests.
- Make v0.4-compatible client parsing accept the direct payload and a single `data` envelope, while still rejecting malformed/missing identity.
- Re-pairing replaces an orphaned connector safely using the existing createPairing upsert.

## Non-goals
No passwords are transmitted or stored; no LIVE authorization expansion.
