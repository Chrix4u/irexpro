# Exact-owner Pepperstone USD DEMO prospective quality observation

Flag: `IREXPRO_OWNER_DEMO_PROSPECTIVE_ENTRY_QUALITY_SHADOW=enabled`.

This is a live-computed pre-dispatch observation of M5 alignment, M30 directional efficiency, H4, expert state, zero-sample/OOD admission reasons and confidence. It is captured in `trading.m1_tactical_decisions.governance.ownerDemoProspectiveEntryQualityShadow` at record creation. No historical outcomes are used to decide its labels. State is `ACTIVE_SHADOW` only with exact owner, professional DEMO phase and a verified Pepperstone USD DEMO connection; otherwise `DISABLED`, `SCOPE_UNVERIFIED`, or `FEATURES_MISSING`.

`M5_M30_BOTH_SUPPORT`, `M5_M30_DISAGREE`, and `M5_M30_BOTH_ADVERSE` are **descriptive**, not calibrated trade probabilities. The post-hoc same-day 19-trade study has no independent admission threshold and contained nine profitable trades a hard rejection would have sacrificed. This observation has no execution/risk/lot/exit effects, no authority to promote LIVE, and no timer or broker order calls. The existing stopped owner DEMO session remains stopped unless the user explicitly restarts it.

For later promotion, require sufficient *new, unseen* outcomes, costs, stratified pair/regime validation and a manually reviewed failure analysis. Retain original stop, risk, broker identity and LIVE verification controls unchanged. Existing fitted `ownerDemoEntryOutcomeShadow` low-score rejected 4 winners/0 losers on 2026-11-23; do not promote it from shadow.
