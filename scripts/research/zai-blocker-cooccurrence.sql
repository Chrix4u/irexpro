-- z.ai blocker and drift attribution — independently corrected 2026-11-03.
-- READ ONLY. Root cause is NOT equivalent to the raw count of veto strings.
-- In ensemble_shadow_decisions the raw reasons array commonly does not contain
-- DRIFT_*, while components->governance->driftState DOES report drift.
-- Without linked resolved shadow outcomes, no blocked-policy promotion follows.
-- Diagnostic groups are categories, not ground-truth causal labels.

-- 1. Engine reason frequency. Fixed original invalid ORDER BY n alias.
WITH decisions AS (
 SELECT id,reasons FROM trading.ensemble_shadow_decisions
 WHERE engine_code='irexpro-multimodel-ensemble-v1'
 AND evaluated_at>=now()-interval '30 days'
), expanded AS (
 SELECT d.id,b.blocker
 FROM decisions d CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(d.reasons)='array' THEN d.reasons ELSE '[]'::jsonb END
 ) b(blocker)
)
SELECT blocker,COUNT(DISTINCT id) AS decisions_with_blocker
FROM expanded GROUP BY blocker ORDER BY decisions_with_blocker DESC LIMIT 50;

-- 2. Number of raw blockers versus distinct diagnostic GROUPS.
-- Do NOT mislabel generic NOT_ADMITTED wrappers as CONFIDENCE_FLOOR.
WITH exploded AS (
 SELECT d.id,b.blocker FROM trading.ensemble_shadow_decisions d
 CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(d.reasons)='array' THEN d.reasons ELSE '[]'::jsonb END
 ) b(blocker)
 WHERE d.engine_code='irexpro-multimodel-ensemble-v1'
 AND d.evaluated_at>=now()-interval '30 days'
), categorized AS (
 SELECT id,CASE
  WHEN blocker LIKE '%CONFIDENCE_FLOOR%' THEN 'CONFIDENCE'
  WHEN blocker LIKE '%NOT_ADMITTED%' OR blocker LIKE '%NOT_PROMOTABLE%'
    THEN 'ADMISSION_WRAPPER'
  WHEN blocker LIKE '%EXPECTED_R%' OR blocker LIKE '%EXPECTED_VALUE%'
    OR blocker LIKE '%PAYOFF%' THEN 'ECONOMICS'
  WHEN blocker LIKE '%DRIFT%' THEN 'DRIFT'
  WHEN blocker LIKE '%SPREAD%' OR blocker LIKE '%EXECUTION_COST%'
    THEN 'EXECUTION_COST'
  WHEN blocker LIKE '%EVENT_RISK%' THEN 'EVENT_RISK'
  WHEN blocker LIKE '%SLEEVE%' THEN 'SLEEVE'
  WHEN blocker LIKE '%TIMING%' OR blocker LIKE '%NOT_M1_CONFIRMED%' THEN 'TIMING'
  WHEN blocker LIKE '%PORTFOLIO%' THEN 'PORTFOLIO'
  WHEN blocker LIKE '%RELIABILITY%' OR blocker LIKE '%SCOUT%'
    OR blocker LIKE '%DEGRADED%' THEN 'SCOUT_RELIABILITY'
  ELSE 'OTHER' END AS diagnostic_group
 FROM exploded
), per_decision AS (
 SELECT id,COUNT(*) AS raw_blocker_count,
 COUNT(DISTINCT diagnostic_group) AS diagnostic_group_count
 FROM categorized GROUP BY id
)
SELECT raw_blocker_count,diagnostic_group_count,COUNT(*) AS decisions
FROM per_decision GROUP BY raw_blocker_count,diagnostic_group_count
ORDER BY decisions DESC LIMIT 30;

-- 3. Frequently co-occurring raw veto strings, not necessarily duplicates.
WITH x AS (
 SELECT d.id,b.blocker FROM trading.ensemble_shadow_decisions d
 CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(d.reasons)='array' THEN d.reasons ELSE '[]'::jsonb END
 ) b(blocker)
 WHERE d.engine_code='irexpro-multimodel-ensemble-v1'
 AND d.evaluated_at>=now()-interval '30 days'
)
SELECT a.blocker AS blocker_a,b.blocker AS blocker_b,
 COUNT(DISTINCT a.id) AS joint_decisions
FROM x a JOIN x b ON a.id=b.id AND a.blocker<b.blocker
GROUP BY a.blocker,b.blocker ORDER BY joint_decisions DESC LIMIT 25;

-- 4. Compare candidate confidence and ensemble-score scales.
-- Percentile_cont returns float8; explicit ::numeric needed for ROUND(...,4).
SELECT COUNT(*) AS n,
 ROUND(MIN(confidence::numeric),4) AS confidence_min,
 ROUND((percentile_cont(0.1) WITHIN GROUP
   (ORDER BY confidence::numeric))::numeric,4) AS confidence_p10,
 ROUND((percentile_cont(0.5) WITHIN GROUP
   (ORDER BY confidence::numeric))::numeric,4) AS confidence_p50,
 ROUND((percentile_cont(0.9) WITHIN GROUP
   (ORDER BY confidence::numeric))::numeric,4) AS confidence_p90,
 ROUND(MAX(confidence::numeric),4) AS confidence_max,
 ROUND((percentile_cont(0.5) WITHIN GROUP
   (ORDER BY ensemble_score::numeric))::numeric,4) AS ensemble_score_p50,
 ROUND((percentile_cont(0.9) WITHIN GROUP
   (ORDER BY ensemble_score::numeric))::numeric,4) AS ensemble_score_p90,
 ROUND(MAX(ensemble_score::numeric),4) AS ensemble_score_max,
 COUNT(*) FILTER(WHERE ensemble_score::numeric>=0.60) AS score_gte_060,
 COUNT(*) FILTER(WHERE confidence::numeric>=0.80) AS confidence_gte_080,
 COUNT(*) FILTER(WHERE confidence::numeric>=0.88) AS confidence_gte_088
FROM trading.ensemble_shadow_decisions
WHERE engine_code='irexpro-multimodel-ensemble-v1';

-- 5. Real drift prevalence from nested governance, NOT the reasons array.
-- This is a veto prevalence report, not a DRIFT-only resolved payoff study.
WITH d AS (
 SELECT COALESCE(components->'governance'->>'driftState','MISSING')
    AS drift_state,
 components->'governance'->>'netExpectedR' AS predicted_net_r,
 (components ? 'outcome') AS has_linked_outcome
 FROM trading.ensemble_shadow_decisions
 WHERE engine_code='irexpro-multimodel-ensemble-v1'
 AND evaluated_at>=now()-interval '30 days'
)
SELECT drift_state,COUNT(*) AS n,
 COUNT(*) FILTER(WHERE has_linked_outcome) AS rows_with_linked_outcome,
 ROUND(AVG(CASE WHEN predicted_net_r ~ '^[-+]?[0-9]+(\\.[0-9]+)?$'
   THEN predicted_net_r::numeric ELSE NULL END),4)
   AS predicted_not_realised_avg_net_r
FROM d GROUP BY drift_state ORDER BY n DESC;

-- 6. Actual current M1 execution blockers (one decision can have many).
SELECT b.blocker,COUNT(DISTINCT d.id) AS decisions
FROM trading.m1_tactical_decisions d
CROSS JOIN LATERAL jsonb_array_elements_text(
 CASE WHEN jsonb_typeof(d.blockers)='array' THEN d.blockers
 ELSE '[]'::jsonb END
) b(blocker)
WHERE d.evaluated_at>=now()-interval '20 minutes'
GROUP BY b.blocker ORDER BY decisions DESC LIMIT 35;
