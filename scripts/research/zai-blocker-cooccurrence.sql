-- ============================================================================
-- zai-blocker-cooccurrence.sql
-- Part of the z.ai independent model/productivity review (2026-11-03).
-- Branch: zai/model-productivity-review-20261102
--
-- Purpose: quantify report finding F4 — "one root cause surfaces as up to five
-- blockers" — and give ChatGPT/OpenAI a reproducible baseline for the
-- root-cause attribution change (report proposal P4).
--
-- Source: trading.ensemble_shadow_decisions (columns per the INSERT in
-- vps-forex-signal-collector.service.ts:6467-6496: engine_code, model_version,
-- instrument, direction, evaluated_at, confidence, ensemble_score,
-- meta_probability, expected_r, consensus_passed, consensus_required, admitted,
-- execution_authority, reasons JSONB, components JSONB).
--
-- READ-ONLY.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. Blocker frequency (decision-level, active engine & policy version)
-- ---------------------------------------------------------------------------
WITH decisions AS (
  SELECT *
  FROM trading.ensemble_shadow_decisions
  WHERE engine_code = 'irexpro-multimodel-ensemble-v1'
    -- AND evaluated_at >= now() - interval '30 days'
),
blockers AS (
  SELECT d.id, d.evaluated_at, d.instrument, d.direction,
         d.confidence, d.ensemble_score, d.meta_probability, d.expected_r,
         jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(d.reasons) = 'array' THEN d.reasons
                ELSE '[]'::jsonb END
         ) AS blocker
  FROM decisions d
)
SELECT blocker, COUNT(*) AS n_decisions_with_blocker
FROM blockers
GROUP BY blocker
ORDER BY n DESC
LIMIT 50;

-- ---------------------------------------------------------------------------
-- §2. Root-cause collapse: how many blockers per decision, and which
--     canonical cause dominates. Canonical mapping follows ZAI_REVIEW_REPORT
--     §4 proposal P4 (CONFIDENCE_FLOOR | NET_EXPECTED_R | DRIFT | SPREAD |
--     EVENT_RISK | SLEEVE | TIMING | PORTFOLIO | OTHER).
-- ---------------------------------------------------------------------------
WITH decisions AS (
  SELECT *
  FROM trading.ensemble_shadow_decisions
  WHERE engine_code = 'irexpro-multimodel-ensemble-v1'
),
exploded AS (
  SELECT d.id, d.confidence, d.expected_r,
         jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(d.reasons) = 'array' THEN d.reasons
                ELSE '[]'::jsonb END
         ) AS blocker
  FROM decisions d
),
canon AS (
  SELECT id,
    CASE
      WHEN blocker LIKE '%CONFIDENCE_FLOOR%' OR blocker = 'PLAN_B_NOT_ADMITTED'
        OR blocker LIKE '%PLAN_B_NOT_ADMITTED%' OR blocker LIKE '%NOT_PAPER_ADMITTED%'
        OR blocker LIKE '%NOT_PROMOTABLE%'              THEN 'CONFIDENCE_FLOOR'
      WHEN blocker LIKE '%NET_EXPECTED_R%' OR blocker LIKE '%EXPECTED_R%'
        OR blocker LIKE '%PAYOFF%'                      THEN 'NET_EXPECTED_R'
      WHEN blocker LIKE '%DRIFT%'                       THEN 'DRIFT'
      WHEN blocker LIKE '%SPREAD%' OR blocker LIKE '%EXECUTION_COST%'
        OR blocker LIKE '%COST%'                        THEN 'SPREAD'
      WHEN blocker LIKE '%EVENT_RISK%'                  THEN 'EVENT_RISK'
      WHEN blocker LIKE '%SLEEVE%'                      THEN 'SLEEVE'
      WHEN blocker LIKE '%TIMING%' OR blocker LIKE '%NOT_M1_CONFIRMED%' THEN 'TIMING'
      WHEN blocker LIKE '%PORTFOLIO%'                   THEN 'PORTFOLIO'
      WHEN blocker LIKE '%RELIABILITY%' OR blocker LIKE '%SCOUT%'
        OR blocker LIKE '%DEGRADED%'                    THEN 'SCOUT_RELIABILITY'
      ELSE 'OTHER'
    END AS cause
  FROM exploded
),
per_decision AS (
  SELECT id,
         COUNT(DISTINCT cause) AS n_causes,
         COUNT(*)              AS n_blockers
  FROM canon GROUP BY id
)
SELECT
  n_blockers,
  n_causes,
  COUNT(*) AS decisions,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM per_decision
GROUP BY n_blockers, n_causes
ORDER BY n_blockers, n_causes;

-- Target after P4: ≥90% of blocked decisions show exactly one canonical cause.

-- ---------------------------------------------------------------------------
-- §3. Co-occurrence matrix (which blockers fire together — proves redundancy)
-- ---------------------------------------------------------------------------
WITH decisions AS (
  SELECT id,
         jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(reasons) = 'array' THEN reasons
                ELSE '[]'::jsonb END
         ) AS blocker
  FROM trading.ensemble_shadow_decisions
  WHERE engine_code = 'irexpro-multimodel-ensemble-v1'
),
pairs AS (
  SELECT a.blocker AS blocker_a, b.blocker AS blocker_b, a.id
  FROM decisions a
  JOIN decisions b ON a.id = b.id AND a.blocker < b.blocker
)
SELECT blocker_a, blocker_b, COUNT(*) AS co_occurrences
FROM pairs
GROUP BY blocker_a, blocker_b
ORDER BY co_occurrences DESC
LIMIT 40;

-- ---------------------------------------------------------------------------
-- §4. Confidence-scale audit (report finding F3)
--     Distribution of the two scales side by side: candidate confidence vs
--     ensemble score. If admission-critical bands never overlap the score's
--     operating range, the M5-handoff bar (MIN_M5_ENSEMBLE_SCORE = 0.6) and
--     the sizing tiers (0.80/0.88) are provably dead.
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*)                                                     AS n,
  ROUND(MIN(confidence::numeric), 4)                           AS conf_min,
  ROUND(percentile_cont(0.1) WITHIN GROUP (ORDER BY confidence::numeric), 4) AS conf_p10,
  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY confidence::numeric), 4) AS conf_p50,
  ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY confidence::numeric), 4) AS conf_p90,
  ROUND(MAX(confidence::numeric), 4)                           AS conf_max,
  ROUND(MIN(ensemble_score::numeric), 4)                       AS score_min,
  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ensemble_score::numeric), 4) AS score_p50,
  ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY ensemble_score::numeric), 4) AS score_p90,
  ROUND(MAX(ensemble_score::numeric), 4)                       AS score_max,
  COUNT(*) FILTER (WHERE ensemble_score::numeric >= 0.6)       AS n_score_ge_060,
  COUNT(*) FILTER (WHERE confidence::numeric >= 0.80)          AS n_conf_ge_080,
  COUNT(*) FILTER (WHERE confidence::numeric >= 0.88)          AS n_conf_ge_088
FROM trading.ensemble_shadow_decisions
WHERE engine_code = 'irexpro-multimodel-ensemble-v1';

-- ---------------------------------------------------------------------------
-- §5. Drift-blocked counterfactual feed (gates report proposal P5)
--     For decisions blocked ONLY by DRIFT_*, pull their components->'outcome'
--     resolution so the shadow 15m/72-bar outcome can answer: would the vetoed
--     trade have been net-positive?
-- ---------------------------------------------------------------------------
WITH drift_only AS (
  SELECT d.id, d.instrument, d.direction, d.evaluated_at,
         d.confidence, d.expected_r,
         d.components->'outcome'->>'status'   AS outcome_status,
         d.components->'outcome'->>'netR'     AS outcome_net_r,
         d.reasons
  FROM trading.ensemble_shadow_decisions d
  WHERE d.engine_code = 'irexpro-multimodel-ensemble-v1'
    AND jsonb_typeof(d.reasons) = 'array'
    AND jsonb_array_length(d.reasons) >= 1
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(d.reasons) r
      WHERE r LIKE 'DRIFT%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(d.reasons) r
      WHERE r NOT LIKE 'DRIFT%'
    )
)
SELECT
  outcome_status,
  COUNT(*)                                     AS n,
  ROUND(AVG(NULLIF(outcome_net_r, '')::numeric), 4) AS avg_net_r,
  ROUND(SUM(NULLIF(outcome_net_r, '')::numeric), 4) AS sum_net_r
FROM drift_only
GROUP BY outcome_status
ORDER BY n DESC;
-- Acceptance for P5 promotion: if sum_net_r across resolved drift-only episodes
-- is materially positive, the envelope is rejecting profitable regimes.
