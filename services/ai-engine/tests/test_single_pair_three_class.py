"""Tests for bounded USDJPY SHORT / NO_TRADE / LONG research."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.single_pair_three_class import (
    LONG_CLASS,
    NO_TRADE_CLASS,
    SHORT_CLASS,
    THREE_CLASS_TARGET,
    _attach_target,
    _weights,
)


def test_three_class_target_maps_event_labels_without_future_filtering():
    frame = pd.DataFrame(
        {
            "event_actionable_target": [0, 1, 1, 0],
            "event_direction_target": [0, 0, 1, 1],
        }
    )

    result = _attach_target(frame)

    assert result[THREE_CLASS_TARGET].tolist() == [
        NO_TRADE_CLASS,
        SHORT_CLASS,
        LONG_CLASS,
        NO_TRADE_CLASS,
    ]
    assert len(result) == len(frame)


def test_three_class_weights_are_finite_positive_and_normalized():
    labels = pd.Series([NO_TRADE_CLASS] * 6 + [SHORT_CLASS] * 2 + [LONG_CLASS] * 2)

    weights = _weights(labels)

    assert len(weights) == len(labels)
    assert np.isfinite(weights).all()
    assert (weights > 0).all()
    assert float(weights.mean()) == pytest.approx(1.0)
