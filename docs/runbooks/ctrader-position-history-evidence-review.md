# cTrader DEMO position-history evidence review

Research only. Do not call broker mutation methods or trigger the execution-capable reconciliation worker. Do not publish account, position or deal IDs or monetary values in this public repository.

## Objective

Distinguish incomplete broad deal retrieval from genuinely absent or multiple position-related closing deals. A provider deal uniqueness rejection alone does not establish a pagination defect.

## Contract

- Official message definitions: https://help.ctrader.com/open-api/messages/#protooadeallistbypositionidreq and https://help.ctrader.com/open-api/messages/#protooadeallistbypositionidres.
- Position-specific request requires the authorized native account and position IDs; timestamps are optional.
- The response requires account identity and a completeness flag. A truncated, malformed, duplicate-ID, or wrong-scope result is not proof.
- Compare complete responses covering the same immutable observation window; if timing or account identity cannot be independently established, stop. Do not compare a single truncated broad page with a complete position response and claim a missing deal.
- Do not substitute the entry order ID for a position ID. Preserve legitimate distinct closing deals, including partial closes occurring in the same millisecond.
- The pure comparator checks native identity cardinality and selected structural fields only. It does not authenticate input, establish monetary equivalence, validate all close-detail fields, or prove dispatch linkage. It is not production settlement code.

## Independent verification

An authorized DEMO operator or reviewer should collect matching scoped read-only evidence for affected positions, including order/deal IDs, deal status, timestamps and volume; compare the same period against complete broad history. Keep raw evidence private. Report aggregate counts and categories only. Confirm that time boundaries are inclusive before accepting the proposed broad-history subdivision. Check the linked local CLOSED trade and dispatch-time evidence separately.

## Release gate

Run the synthetic comparator tests in CI. Do not wire the comparator into runtime recovery or change financial records. Require independent review of provider evidence and proof of correctness before considering a remedy. #841 remains pending actual provider validation; the deployed diagnostics do not resolve the accounting incident.
