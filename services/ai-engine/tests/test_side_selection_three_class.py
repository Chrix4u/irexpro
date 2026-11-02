from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.side_selection_three_class import (
    CATEGORICAL_FEATURES,
    NUMERIC_FEATURES,
    build_preprocessor,
    operational_labels,
    episode_policy_actions,
    model_feature_columns,
    split_research_holdout,
)


def base_rows() -> pd.DataFrame:
    rows = []
    for episode, minute in (("e1", 0), ("e2", 20), ("e3", 40)):
        decision = pd.Timestamp("2026-11-01T10:00:00Z") + pd.Timedelta(minutes=minute)
        resolved = decision + pd.Timedelta(minutes=10)
        for direction in ("BUY", "SELL"):
            rows.append(
                {
                    "episode_id": episode,
                    "decision_time": decision,
                    "market_bar_time": decision,
                    "target_resolved_at": resolved,
                    "instrument": "EURUSD",
                    "direction": direction,
                    "policy_version": "p1",
                    "label": "KEEP",
                    "target_original_net_r": 1.5 if direction == "BUY" else -1.0,
                    "target_opposite_net_r": -1.0 if direction == "BUY" else 1.5,
                    "strategy_route": "EARLY_TRANSITION",
                    "candidate_score": 0.7,
                }
            )
    return pd.DataFrame(rows)


def test_operational_labels_force_low_confidence_to_abstain():
    probabilities = np.asarray(
        [
            [0.72, 0.18, 0.10],
            [0.20, 0.65, 0.15],
            [0.40, 0.35, 0.25],
            [0.10, 0.15, 0.75],
        ],
        dtype=float,
    )
    result = operational_labels(probabilities, confidence_floor=0.60)
    assert result.labels.tolist() == ["KEEP", "FLIP", "ABSTAIN", "ABSTAIN"]
    assert result.confidence.tolist() == pytest.approx([0.72, 0.65, 0.40, 0.75])


def test_episode_policy_combines_relative_keep_flip_into_one_absolute_side():
    frame = base_rows().iloc[:4].copy()
    predicted = np.asarray(["KEEP", "FLIP", "KEEP", "KEEP"], dtype=object)
    confidence = np.asarray([0.8, 0.7, 0.9, 0.85], dtype=float)

    actions = episode_policy_actions(frame, predicted, confidence)

    first = actions.loc[actions["episode_id"] == "e1"].iloc[0]
    assert first["action"] == "BUY"
    assert first["realized_r"] == pytest.approx(1.5)
    second = actions.loc[actions["episode_id"] == "e2"].iloc[0]
    assert second["action"] == "ABSTAIN"
    assert second["realized_r"] == pytest.approx(0.0)


def test_holdout_split_keeps_episode_rows_together_and_purges_labels_resolving_after_boundary():
    frame = base_rows()
    # Make e1's target resolve after the future boundary so it cannot remain in training.
    frame.loc[frame["episode_id"] == "e1", "target_resolved_at"] = pd.Timestamp(
        "2026-11-01T10:45:00Z"
    )

    research, holdout, boundary = split_research_holdout(
        frame,
        holdout_fraction=1 / 3,
        min_holdout_rows=2,
    )

    assert boundary == pd.Timestamp("2026-11-01T10:40:00Z")
    assert set(holdout["episode_id"]) == {"e3"}
    assert "e1" not in set(research["episode_id"])
    assert set(research["episode_id"]) == {"e2"}


def test_preprocessor_handles_unseen_categories_and_model_features_exclude_targets():
    frame = base_rows()
    for name in CATEGORICAL_FEATURES:
        if name not in frame:
            frame[name] = "UNKNOWN"
    for name in NUMERIC_FEATURES:
        if name not in frame:
            frame[name] = np.nan
    frame["strategy_route"] = ["EARLY_TRANSITION"] * len(frame)

    features = model_feature_columns(frame)
    assert "label" not in features
    assert "target_original_net_r" not in features
    assert "target_opposite_net_r" not in features
    assert "target_resolved_at" not in features

    train = frame.iloc[:4].copy()
    valid = frame.iloc[4:].copy()
    valid.loc[:, "strategy_route"] = "NEVER_SEEN_ROUTE"
    preprocessor = build_preprocessor()
    transformed_train = preprocessor.fit_transform(train[features])
    transformed_valid = preprocessor.transform(valid[features])
    assert transformed_train.shape[1] == transformed_valid.shape[1]
    assert transformed_valid.shape[0] == len(valid)


def test_holdout_split_fails_closed_when_future_evidence_is_too_small():
    frame = base_rows()
    with pytest.raises(ValueError, match="future holdout requires at least 4 rows"):
        split_research_holdout(frame, holdout_fraction=1 / 3, min_holdout_rows=4)
