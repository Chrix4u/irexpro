"""Six-pair OOD causal research: read-only price proxy; never train or authorize trades.

The original three-pair OOD learner retains its unchanged admission history and
promotion guard. This sidecar only compares completed 15-minute broker quotes
for all six scanner pairs, with 0.01 JPY and 0.0001 non-JPY pip conventions.
There is no broker commission/fill proof or live execution linkage here.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .ood_shadow_candidate import (
    SIX_PAIR_RESEARCH_PAIRS,
    prepare_cohort,
    summarize_independent_ood_conditions,
)

RESEARCH_ARTIFACT = "ood-six-pair-broker-quote-proxy-v1"


def study_from_csv(source: Path) -> dict:
    verified, quality = prepare_cohort(
        pd.read_csv(source), approved_pairs=SIX_PAIR_RESEARCH_PAIRS
    )
    outcomes = summarize_independent_ood_conditions(verified)
    return {
        "artifact": RESEARCH_ARTIFACT,
        "mode": "SHADOW_ONLY",
        "authority": "NONE",
        "model_fitted": False,
        "execution_allowed": False,
        "modifies_execution": False,
        "auto_promotion": False,
        "promotion_allowed": False,
        "broker_net_pnl_verified": False,
        "pip_size": {
            "USDJPY": 0.01,
            "AUDUSD": 0.0001,
            "EURUSD": 0.0001,
            "GBPUSD": 0.0001,
            "USDCAD": 0.0001,
            "USDCHF": 0.0001,
        },
        "observed_costs": "ENTRY_ASK_BID_AND_EXIT_BID_ASK",
        "unverified_costs": "COMMISSION_SWAP_ACTUAL_FILL_SLIPPAGE",
        "extra_friction_assumption_pips": 1.0,
        "readiness": "DESCRIPTIVE_OBSERVATION_ONLY",
        "data_quality": quality,
        "independent_ood_condition_outcomes": outcomes,
        "warning": (
            "Quote-return proxies are not broker net P&L; pair cohorts share "
            "currency factors and cannot be considered independent validation. "
            "Not an entry signal or permission to reduce drift gates."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only six-pair OOD diagnostics")
    parser.add_argument("--cohort-csv", type=Path, required=True)
    parser.add_argument("--report-json", type=Path, required=True)
    args = parser.parse_args()
    if any(part in {"models", "artifacts", "production"} for part in args.report_json.parts):
        raise ValueError("Refusing to write into a model-serving or production artifact location")
    report = study_from_csv(args.cohort_csv)
    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    print(
        "SIX_PAIR_OOD_SHADOW_READONLY=TRUE "
        "AUTHORITY=NONE "
        f"OBSERVATIONS={report['data_quality']['causally_verified_records']} "
        f"INDEPENDENT_EPISODES={report['independent_ood_condition_outcomes']['independent_opportunities']} "
        "MODEL_FITTED=FALSE EXECUTION_ALLOWED=FALSE"
    )


if __name__ == "__main__":
    main()
