from __future__ import annotations

import numpy as np

from app.domain.training.single_pair_v13_side_specific import (
    select_side_threshold,
)


def test_side_threshold_selection_recovers_separable_signal() -> None:
    result = select_side_threshold(
        np.array([0, 0, 1, 1]),
        np.array([0.02, 0.03, 0.08, 0.12]),
    )
    assert result["balanced_accuracy"] == 1.0
    assert result["precision"] == 1.0
    assert result["recall"] == 1.0
