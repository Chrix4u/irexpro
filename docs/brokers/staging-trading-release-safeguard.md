# iRexPro staging release: active broker safeguards

The staging release script now runs an exact-candidate, read-only PostgreSQL
quiescence guard before checking out a candidate, before migrations, and
immediately before restarting AI/API/website services.

The guard fails closed when the database is unavailable or detects any ACTIVE
AI trading session, PENDING/OPEN/RECONCILIATION_PENDING trade, currently
working/in-flight order, or a reconciliation-uncertain order updated in the
previous hour. It never reads or prints account credentials or account IDs.

This is NOT an automatic pause or trade closer. The user must deliberately
stop AI trading and verify broker exposure/uncertain orders before a maintenance
release. The guard is intentionally conservative: it does not change trading
authorization, qualify a LIVE model, or claim that a no-position database
snapshot proves the broker has no external exposure. A concurrent session
could start after the snapshot; a fully atomic maintenance switch remains a
separate follow-up before unattended production deployment.

At the owner's Pepperstone $50 funding checkpoint on 2026-11-22, there was
one ACTIVE DEMO AI session, no open/pending trades, 375 old
RECONCILIATION_PENDING cTrader DEMO orders and one older ACKNOWLEDGED order.
This guard correctly blocks the deployment on ACTIVE and acknowledged
order state. The 375 historic uncertain orders remain a distinct LIVE
certification blocker; they are NOT assumed to be open broker positions.
No new Windows VPS or MetaAPI integration is necessary for cTrader API
linkage. Do not deploy by force or clear order records without authoritative
broker reconciliation.
