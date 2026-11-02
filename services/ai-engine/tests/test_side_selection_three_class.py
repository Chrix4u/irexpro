from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.side_selection_three_class import (
    BASE_CATEGORICAL_FEATURES,
    BASE_NUMERIC_FEATURES,
    build_episode_dataset,
    build_preprocessor,
    model_feature_columns,
    operational_labels,
    policy_actions,
    split_research_holdout,
)


def direction_rows() -> pd.DataFrame:
    rows = []
    specs = [
        # episode, minute, BUY label/R, SELL label/R
        ("e1", 0, "KEEP", 1.5, "FLIP", -1.0),
        ("e2", 20, "FLIP", -1.0, "KEEP", 1.5),
        ("e3", 40, "ABSTAIN", -1.0, "ABSTAIN", -1.0),
    ]
    for episode, minute, buy_label, buy_r, sell_label, sell_r in specs:
        decision = pd.Timestamp("2026-11-01T10:00:00Z") + pd.Timedelta(minutes=minute)
        resolved = decision + pd.Timedelta(minutes=10)
        for direction, label, own_r, opposite_r, score in (
            ("BUY", buy_label, buy_r, sell_r, 0.80),
            ("SELL", sell_label, sell_r, buy_r, 0.60),
        ):
            row = {
                "episode_id": episode,
                "decision_time": decision,
                "market_bar_time": decision,
                "target_resolved_at": resolved,
                "instrument": "EURUSD",
                "direction": direction,
                "policy_version": "p1",
                "label": label,
                "target_original_net_r": own_r,
                "target_opposite_net_r": opposite_r,
                "strategy_route": "EARLY_TRANSITION" if direction == "BUY" else "TREND_CONTINUATION",
                "candidate_score": score,
                "short_horizon_momentum_atr": 0.3 if direction == "BUY" else -0.2,
                "pattern_available": True,
                "pattern_aligned_momentum3_atr": 0.4 if direction == "BUY" else -0.1,
                "pattern_raw_path_efficiency6": 0.7,
                "pattern_h1_alignment": 0.35 if direction == "BUY" else 0.05,
            }
            for name in BASE_CATEGORICAL_FEATURES:
                row.setdefault(name, "UNKNOWN")
            for name in BASE_NUMERIC_FEATURES:
                row.setdefault(name, np.nan)
            row["candidate_score"] = score
            row["short_horizon_momentum_atr"] = 0.3 if direction == "BUY" else -0.2
            rows.append(row)
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


def test_episode_dataset_uses_higher_score_primary_and_pairwise_deltas():
    episodes = build_episode_dataset(direction_rows())

    assert episodes["label"].tolist() == ["KEEP", "FLIP", "ABSTAIN"]
    assert episodes["primary_direction"].tolist() == ["BUY", "BUY", "BUY"]
    assert episodes["primary__candidate_score"].tolist() == pytest.approx([0.8, 0.8, 0.8])
    assert episodes["opposite__candidate_score"].tolist() == pytest.approx([0.6, 0.6, 0.6])
    assert episodes["delta__candidate_score"].tolist() == pytest.approx([0.2, 0.2, 0.2])
    assert episodes["delta__short_horizon_momentum_atr"].tolist() == pytest.approx([0.5, 0.5, 0.5])
    assert episodes["primary__pattern_available"].tolist() == pytest.approx([1.0, 1.0, 1.0])
    assert episodes["delta__pattern_aligned_momentum3_atr"].tolist() == pytest.approx([0.5, 0.5, 0.5])
    assert episodes["delta__pattern_h1_alignment"].tolist() == pytest.approx([0.3, 0.3, 0.3])
    assert episodes["primary__strategy_route"].tolist() == ["EARLY_TRANSITION"] * 3
    assert episodes["opposite__strategy_route"].tolist() == ["TREND_CONTINUATION"] * 3


def test_policy_actions_score_keep_flip_and_abstain_once_per_episode():
    episodes = build_episode_dataset(direction_rows())
    predicted = np.asarray(["KEEP", "FLIP", "ABSTAIN"], dtype=object)
    confidence = np.asarray([0.8, 0.75, 0.9], dtype=float)

    actions = policy_actions(episodes, predicted, confidence)

    assert actions["action"].tolist() == ["KEEP", "FLIP", "ABSTAIN"]
    assert actions["realized_r"].tolist() == pytest.approx([1.5, 1.5, 0.0])


def test_holdout_split_keeps_episode_atomic_and_purges_labels_resolving_after_boundary():
    episodes = build_episode_dataset(direction_rows())
    episodes.loc[episodes["episode_id"] == "e1", "target_resolved_at"] = pd.Timestamp(
        "2026-11-01T10:45:00Z"
    )

    research, holdout, boundary = split_research_holdout(
        episodes,
        holdout_fraction=1 / 3,
        min_holdout_rows=1,
    )

    assert boundary == pd.Timestamp("2026-11-01T10:40:00Z")
    assert set(holdout["episode_id"]) == {"e3"}
    assert "e1" not in set(research["episode_id"])
    assert set(research["episode_id"]) == {"e2"}


def test_preprocessor_handles_unseen_categories_and_excludes_targets():
    episodes = build_episode_dataset(direction_rows())
    features = model_feature_columns(episodes)
    assert "label" not in features
    assert "target_keep_r" not in features
    assert "target_flip_r" not in features
    assert "target_resolved_at" not in features

    train = episodes.iloc[:2].copy()
    valid = episodes.iloc[2:].copy()
    valid.loc[:, "primary__strategy_route"] = "NEVER_SEEN_ROUTE"
    preprocessor = build_preprocessor()
    transformed_train = preprocessor.fit_transform(train[features])
    transformed_valid = preprocessor.transform(valid[features])
    assert transformed_train.shape[1] == transformed_valid.shape[1]
    assert transformed_valid.shape[0] == len(valid)


def test_holdout_split_expands_beyond_fraction_to_preserve_minimum_future_evidence():
    base = build_episode_dataset(direction_rows())
    copies = []
    for index in range(3):
        copy = base.copy()
        copy["episode_id"] = copy["episode_id"].map(lambda value: f"{value}-{index}")
        copy["decision_time"] = copy["decision_time"] + pd.Timedelta(hours=index * 2)
        copy["market_bar_time"] = copy["market_bar_time"] + pd.Timedelta(hours=index * 2)
        copy["target_resolved_at"] = copy["target_resolved_at"] + pd.Timedelta(hours=index * 2)
        copies.append(copy)
    episodes = pd.concat(copies, ignore_index=True).sort_values("decision_time").reset_index(drop=True)

    research, holdout, _ = split_research_holdout(
        episodes, holdout_fraction=0.20, min_holdout_rows=3
    )

    assert len(holdout) == 3
    assert len(research) >= 3


def test_holdout_split_fails_closed_when_total_evidence_cannot_preserve_minimum_future_set():
    episodes = build_episode_dataset(direction_rows())
    with pytest.raises(ValueError, match="future holdout requires at least 4 episodes"):
        split_research_holdout(episodes, holdout_fraction=1 / 3, min_holdout_rows=4)
