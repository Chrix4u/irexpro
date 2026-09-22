"""Leakage-safe diagnostics for multi-timeframe model qualification research."""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np
import pandas as pd
from sklearn.metrics import confusion_matrix

from app.domain.training.validation import compute_classification_metrics

DIAGNOSTIC_QUANTILES = (0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99)
CALIBRATION_BIN_COUNT = 10
SMALL_EVIDENCE_PERIODS = 30
VERY_SMALL_EVIDENCE_PERIODS = 15


def _quantile_report(values: np.ndarray) -> dict[str, float]:
    if len(values) == 0:
        return {}
    return {
        f"p{int(round(q * 100)):02d}": float(np.quantile(values, q))
        for q in DIAGNOSTIC_QUANTILES
    }


def _binary_distribution(values: np.ndarray) -> dict[str, dict[str, float | int]]:
    total = int(len(values))
    short_count = int((values == 0).sum())
    long_count = int((values == 1).sum())
    denominator = float(total) if total else 1.0
    return {
        "SHORT": {
            "count": short_count,
            "fraction": float(short_count / denominator),
        },
        "LONG": {
            "count": long_count,
            "fraction": float(long_count / denominator),
        },
    }


def _calibration_bins(
    y_true: np.ndarray,
    probabilities: np.ndarray,
) -> list[dict[str, float | int]]:
    edges = np.linspace(0.0, 1.0, CALIBRATION_BIN_COUNT + 1)
    assignments = np.clip(
        np.digitize(probabilities, edges[1:-1], right=False),
        0,
        CALIBRATION_BIN_COUNT - 1,
    )
    rows: list[dict[str, float | int]] = []
    for index in range(CALIBRATION_BIN_COUNT):
        mask = assignments == index
        count = int(mask.sum())
        if count == 0:
            continue
        rows.append(
            {
                "bin": index + 1,
                "lower": float(edges[index]),
                "upper": float(edges[index + 1]),
                "count": count,
                "mean_probability": float(probabilities[mask].mean()),
                "observed_long_fraction": float(y_true[mask].mean()),
            }
        )
    return rows


def diagnose_directional_predictions(
    predictions: pd.DataFrame,
    *,
    confidence_threshold: float = 0.60,
    decision_threshold: float = 0.50,
) -> dict[str, Any]:
    """Return classification/calibration diagnostics without changing decisions."""
    if not 0.60 <= confidence_threshold < 1.0:
        raise ValueError("qualification confidence threshold must remain >= 0.60 and < 1.0")
    if not 0.40 <= decision_threshold <= 0.60:
        raise ValueError("diagnostic decision threshold must remain in [0.40, 0.60]")
    required = {"target", "positive_probability"}
    missing = sorted(required.difference(predictions.columns))
    if missing:
        raise ValueError(f"Prediction diagnostics missing required columns: {missing}")
    if predictions.empty:
        raise ValueError("Prediction diagnostics require at least one row")

    y_true = pd.to_numeric(predictions["target"], errors="coerce").to_numpy(dtype=float)
    probabilities = pd.to_numeric(
        predictions["positive_probability"], errors="coerce"
    ).to_numpy(dtype=float)
    if not np.isfinite(y_true).all() or not np.isin(y_true, [0.0, 1.0]).all():
        raise ValueError("Prediction diagnostics require finite binary targets")
    if not np.isfinite(probabilities).all():
        raise ValueError("Prediction diagnostics require finite probabilities")

    y = y_true.astype(int)
    probabilities = np.clip(probabilities, 1e-7, 1.0 - 1e-7)
    predicted = (probabilities >= decision_threshold).astype(int)
    confidence = np.maximum(probabilities, 1.0 - probabilities)
    active = confidence >= confidence_threshold

    tn, fp, fn, tp = confusion_matrix(y, predicted, labels=[0, 1]).ravel()
    sensitivity = float(tp / (tp + fn)) if (tp + fn) else 0.0
    specificity = float(tn / (tn + fp)) if (tn + fp) else 0.0
    true_long_fraction = float(y.mean())
    predicted_long_fraction = float(predicted.mean())
    classification = compute_classification_metrics(
        y,
        probabilities,
        threshold=decision_threshold,
    )

    high_conf_long = int(((predicted == 1) & active).sum())
    high_conf_short = int(((predicted == 0) & active).sum())
    coverage = float(active.mean())

    warnings: list[str] = []
    if predicted_long_fraction >= 0.95 or predicted_long_fraction <= 0.05:
        warnings.append("directional_prediction_collapse")
    if abs(predicted_long_fraction - true_long_fraction) >= 0.10:
        warnings.append("material_directional_bias")
    if coverage < 0.01:
        warnings.append("very_low_confidence_coverage")
    elif coverage < 0.05:
        warnings.append("low_confidence_coverage")

    return {
        "true_class_distribution": _binary_distribution(y),
        "predicted_class_distribution": _binary_distribution(predicted),
        "confusion_matrix": {
            "true_short_pred_short": int(tn),
            "true_short_pred_long": int(fp),
            "true_long_pred_short": int(fn),
            "true_long_pred_long": int(tp),
        },
        "sensitivity": sensitivity,
        "specificity": specificity,
        "balanced_accuracy": classification["balanced_accuracy"],
        "precision": classification["precision"],
        "recall": classification["recall"],
        "f1": classification["f1"],
        "roc_auc": classification["roc_auc"],
        "log_loss": classification["log_loss"],
        "brier_score": classification["brier_score"],
        "probability_quantiles": _quantile_report(probabilities),
        "confidence_quantiles": _quantile_report(confidence),
        "decision_threshold": decision_threshold,
        "confidence_threshold": confidence_threshold,
        "confidence_coverage": {
            "count": int(active.sum()),
            "fraction": coverage,
        },
        "high_confidence_signal_counts": {
            "LONG": high_conf_long,
            "SHORT": high_conf_short,
        },
        "directional_bias": {
            "true_long_fraction": true_long_fraction,
            "predicted_long_fraction": predicted_long_fraction,
            "predicted_minus_true": float(predicted_long_fraction - true_long_fraction),
        },
        "calibration_bins": _calibration_bins(y, probabilities),
        "warnings": warnings,
    }


def evidence_sufficiency_warnings(
    *,
    trade_or_period_count: int,
    sharpe_ratio: float | None,
    confidence_coverage: float,
    by_instrument_period_counts: dict[str, int] | None = None,
) -> list[str]:
    """Flag fragile evidence without creating or changing a promotion gate."""
    warnings: list[str] = []
    if trade_or_period_count < VERY_SMALL_EVIDENCE_PERIODS:
        warnings.append("very_small_non_overlapping_trade_sample")
    elif trade_or_period_count < SMALL_EVIDENCE_PERIODS:
        warnings.append("small_non_overlapping_trade_sample")
    if (
        sharpe_ratio is not None
        and sharpe_ratio >= 1.0
        and trade_or_period_count < SMALL_EVIDENCE_PERIODS
    ):
        warnings.append("high_sharpe_with_small_trade_sample")
    if confidence_coverage < 0.01:
        warnings.append("very_low_confidence_coverage")
    elif confidence_coverage < 0.05:
        warnings.append("low_confidence_coverage")
    if by_instrument_period_counts:
        sparse = sorted(
            instrument
            for instrument, count in by_instrument_period_counts.items()
            if count < 5
        )
        if sparse:
            warnings.append("sparse_instrument_trade_evidence:" + ",".join(sparse))
    return warnings


def _regime_slice(
    frame: pd.DataFrame,
    mask: pd.Series,
    *,
    confidence_threshold: float,
) -> dict[str, Any] | None:
    subset = frame.loc[mask]
    if len(subset) < 20 or subset["target"].nunique() < 2:
        return None
    diagnostics = diagnose_directional_predictions(
        subset,
        confidence_threshold=confidence_threshold,
    )
    return {
        "rows": int(len(subset)),
        "balanced_accuracy": diagnostics["balanced_accuracy"],
        "brier_score": diagnostics["brier_score"],
        "confidence_coverage": diagnostics["confidence_coverage"]["fraction"],
        "predicted_long_fraction": diagnostics["directional_bias"][
            "predicted_long_fraction"
        ],
    }


def causal_regime_diagnostics(
    predictions: pd.DataFrame,
    *,
    confidence_threshold: float = 0.60,
) -> dict[str, Any]:
    """Summarize already-causal outer-fold features; never creates model inputs."""
    report: dict[str, Any] = {}

    if "m1_volatility_20" in predictions.columns:
        values = pd.to_numeric(predictions["m1_volatility_20"], errors="coerce")
        finite = values[np.isfinite(values)]
        if len(finite) >= 60:
            low, high = np.quantile(finite, [1.0 / 3.0, 2.0 / 3.0])
            volatility: dict[str, Any] = {
                "boundaries": {"low_upper": float(low), "high_lower": float(high)}
            }
            masks = {
                "low": values <= low,
                "mid": (values > low) & (values < high),
                "high": values >= high,
            }
            for name, mask in masks.items():
                result = _regime_slice(
                    predictions,
                    mask.fillna(False),
                    confidence_threshold=confidence_threshold,
                )
                if result is not None:
                    volatility[name] = result
            report["m1_volatility_20"] = volatility

    if "h1_rsi_14" in predictions.columns:
        values = pd.to_numeric(predictions["h1_rsi_14"], errors="coerce")
        rsi: dict[str, Any] = {}
        masks = {
            "below_40": values < 40.0,
            "40_to_60": (values >= 40.0) & (values <= 60.0),
            "above_60": values > 60.0,
        }
        for name, mask in masks.items():
            result = _regime_slice(
                predictions,
                mask.fillna(False),
                confidence_threshold=confidence_threshold,
            )
            if result is not None:
                rsi[name] = result
        if rsi:
            report["h1_rsi_14"] = rsi

    return report


def feature_gain_diagnostics(
    model: Any,
    feature_columns: Sequence[str],
    *,
    top_n: int = 20,
) -> list[dict[str, float | str]]:
    """Return normalized XGBoost gain importance when a fitted booster exposes it."""
    if top_n < 1:
        raise ValueError("top_n must be positive")
    get_booster = getattr(model, "get_booster", None)
    if not callable(get_booster):
        return []
    booster = get_booster()
    raw = booster.get_score(importance_type="gain")
    if not raw:
        return []

    resolved: dict[str, float] = {}
    for raw_name, raw_gain in raw.items():
        name = str(raw_name)
        if name.startswith("f") and name[1:].isdigit():
            index = int(name[1:])
            if index < len(feature_columns):
                name = str(feature_columns[index])
        if name in feature_columns:
            resolved[name] = float(raw_gain)

    total = float(sum(resolved.values()))
    if total <= 0.0:
        return []
    ranked = sorted(resolved.items(), key=lambda item: (-item[1], item[0]))[:top_n]
    return [
        {
            "feature": name,
            "gain": gain,
            "normalized_gain": float(gain / total),
        }
        for name, gain in ranked
    ]
