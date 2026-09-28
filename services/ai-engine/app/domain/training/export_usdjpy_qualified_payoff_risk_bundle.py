"""Export an exact qualified USDJPY v10 payoff-risk candidate for Research PAPER UAT."""
from __future__ import annotations
import argparse, hashlib, json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_BACKTEST_POLICY,
    MULTITIMEFRAME_FEATURE_COLUMNS,
    MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
    MULTITIMEFRAME_RUNTIME_PROFILE,
)
from app.domain.training.model_qualification import (
    EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME,
    ModelVariant,
    _fit_event_hybrid_payoff_risk_for_outer,
)
from app.domain.training.train_multitimeframe import EVENT_LABEL_POLICY, load_and_prepare_corpora

MODEL_TYPE = "xgboost_event_pair_bundle"
ACTION_MARGIN_FLOOR = 0.10
PAYOFF_RISK_RATIO_FLOOR = 1.15

def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()

def schema_hash(cols: list[str]) -> str:
    payload = json.dumps(cols, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(payload).hexdigest()
def save(model: Any, path: Path, kind: str) -> dict[str, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".tmp" + path.suffix)
    model.save_model(str(tmp))
    tmp.replace(path)
    return {"path": path.name, "sha256": sha(path), "kind": kind}

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--qualification-report", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    report_path = Path(args.qualification_report)
    report = json.loads(report_path.read_text())
    horizon = int(report.get("horizon_bars", -1))
    cutoff = report.get("qualification_decision_time_before")
    datasets = report.get("dataset_sha256", {})
    candidate = report.get("experiments", {}).get(
        EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME, {}
    )
    gate = candidate.get("research_gate", {})
    if horizon != 1:
        raise ValueError(f"Expected exact qualified h1 candidate, got h{horizon}")
    if not cutoff:
        raise ValueError("Qualification report has no frozen cutoff")
    if not bool(gate.get("research_gate_passed", False)):
        raise ValueError("Refusing to export a candidate that did not pass its research gate")
    if report.get("single_pair_scope", {}).get("experiment") != EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME:
        raise ValueError("Qualification experiment identity mismatch")
    dataset_path = Path(args.dataset)
    actual_dataset_sha = sha(dataset_path)
    expected_dataset_sha = str(datasets.get("USDJPY", ""))
    if actual_dataset_sha != expected_dataset_sha:
        raise ValueError(
            f"Dataset does not match qualification evidence: {actual_dataset_sha} != {expected_dataset_sha}"
        )
    pooled, hashes = load_and_prepare_corpora(
        {"USDJPY": str(dataset_path)},
        horizon_bars=horizon,
        decision_time_before=cutoff,
    )
    if hashes != datasets:
        raise ValueError("Prepared corpus hash diverged from qualification report")

    direction, opportunity, payoff, features, counts = (
        _fit_event_hybrid_payoff_risk_for_outer(
            pooled,
            variant=ModelVariant(name="event_barrier_v10_hybrid_payoff_risk"),
            horizon_bars=horizon,
        )
    )
    if list(features) != list(MULTITIMEFRAME_FEATURE_COLUMNS):
        raise ValueError("Feature schema mismatch")

    out = Path(args.output)
    root = out.parent
    specs = {
        "opportunity": save(opportunity, root / "opportunity.json", "xgboost_classifier"),
        "long_direction": save(direction["long"], root / "long-direction.json", "xgboost_classifier"),
        "short_direction": save(direction["short"], root / "short-direction.json", "xgboost_classifier"),
    }
    for name in ("long_upside", "long_downside", "short_upside", "short_downside"):
        specs[f"payoff_{name}"] = save(
            payoff[name], root / f"payoff-{name.replace('_','-')}.json", "xgboost_regressor"
        )
    manifest = {
        "bundle_version": 1,
        "model_type": MODEL_TYPE,
        "experiment": EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME,
        "event_label_policy": EVENT_LABEL_POLICY,
        "hybrid_payoff_risk": {
            "kind": "xgboost_hybrid_opportunity_dual_direction_payoff_risk",
            "confidence_floor": 0.60,
            "action_margin_floor": ACTION_MARGIN_FLOOR,
            "payoff_risk_ratio_floor": PAYOFF_RISK_RATIO_FLOOR,
            **specs,
        },
    }
    root.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    tmp.replace(out)

    now = datetime.now(UTC)
    version = f"usdjpy-v10-payoff-risk-qualified-h1-research-uat-{now.strftime('%Y%m%dT%H%M%SZ')}"
    metadata = {
        "metadata_version": 4,
        "model_type": MODEL_TYPE,
        "runtime_feature_profile": MULTITIMEFRAME_RUNTIME_PROFILE,
        "research_experiment": EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME,
        "event_label_policy": EVENT_LABEL_POLICY,
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "research_validation_policy": MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
        "model_version": version,
        "artifact_sha256": sha(out),
        "feature_columns": list(MULTITIMEFRAME_FEATURE_COLUMNS),
        "feature_schema_hash": schema_hash(list(MULTITIMEFRAME_FEATURE_COLUMNS)),
        "feature_count": len(MULTITIMEFRAME_FEATURE_COLUMNS),
        "training_data_source": "qualified frozen USDJPY multitimeframe research corpus",
        "dataset_sha256": hashes,
        "instruments": ["USDJPY"],
        "horizon_bars": horizon,
        "confidence_threshold": 0.60,
        "opportunity_threshold": 0.60,
        "direction_threshold": 0.50,
        "action_margin_floor": ACTION_MARGIN_FLOOR,
        "payoff_risk_ratio_floor": PAYOFF_RISK_RATIO_FLOOR,
        "training_counts": counts,
        "qualification_report_path": str(report_path.resolve()),
        "qualification_report_sha256": sha(report_path),
        "qualification_frame_sha256": report.get("qualification_frame_sha256"),
        "qualification_checkpoint_fingerprint": report.get("qualification_checkpoint_fingerprint"),
        "qualification_decision_time_before": cutoff,
        "qualification_frame_rows": report.get("qualification_frame_rows"),
        "research_gate": gate,
        "research_gate_passed": True,
        "validation_status": "qualified_research_candidate_paper_uat_not_formally_promoted",
        "approved_for_paper": False,
        "approved_for_sandbox": False,
        "approved_for_live": False,
        "research_paper_uat_only": True,
        "sealed_future_holdout_consumed": False,
        "created_at": now.isoformat(),
    }
    mp = out.with_suffix(".metadata.json")
    mt = mp.with_suffix(mp.suffix + ".tmp")
    mt.write_text(json.dumps(metadata, indent=2, sort_keys=True))
    mt.replace(mp)
    print(json.dumps({
        "model_path": str(out),
        "metadata_path": str(mp),
        "model_version": version,
        "rows": len(pooled),
        "start": str(pooled.decision_time.min()),
        "end": str(pooled.decision_time.max()),
        "research_gate_passed": True,
        "approved_for_paper": False,
    }, sort_keys=True))

if __name__ == "__main__":
    main()
