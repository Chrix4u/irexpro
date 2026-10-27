# M1 realised-loss brake design

The current M1 early-transition provisional lane can remain executable on three old positive shadow samples while executed pair-side trades have already deteriorated. On 2026-10-27 EURUSD BUY recorded two realised losses, then three additional overlapping BUY entries were opened because realised reliability still treated 0W/2L as insufficient evidence and the scheduler had no same-side active-intent veto.

The fix is deliberately narrow. M1_EARLY_TRANSITION brakes after two consecutive realised losses; trend-continuation and confirmed-reversal retain the existing three-loss early brake. Separately, before a new M1 signal is submitted, an active CREATED intent or OPEN trade on the same instrument and direction blocks another M1 entry. This does not block other pairs or the opposite direction and does not lower any entry/risk threshold.
