"""Tests for per-instrument corpus batch training and bundle manifests."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd

from app.domain.training import train_corpus


def _write_verified_corpus(
    corpus_dir: Path,
    instrument: str,
    timeframe: str = "H1",
) -> Path:
    dataset_path = corpus_dir / f"{instrument}_{timeframe}.csv"
    frame = pd.DataFrame(
        {
            "timestamp": ["2025-01-01T00:00:00+00:00", "2025-01-01T01:00:00+00:00"],
            "open": [1.1, 1.2],
            "high": [1.11, 1.21],
            "low": [1.09, 1.19],
            "close": [1.105, 1.205],
            "volume": [1000, 1100],
        }
    )
    frame.to_csv(dataset_path, index=False)
    digest = hashlib.sha256(dataset_path.read_bytes()).hexdigest()
    manifest = {
        "manifest_version": 1,
        "source": "broker_internal_historical_ohlcv",
        "instrument": instrument,
        "timeframe": timeframe,
        "dataset_sha256": digest,
        "closed_candles_only": True,
    }
    dataset_path.with_suffix(".manifest.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )
    return dataset_path


def test_batch_training_creates_one_bundle_route_per_verified_corpus(tmp_path, monkeypatch):
    corpus_dir = tmp_path / "corpus"
    output_dir = tmp_path / "models"
    corpus_dir.mkdir()
    _write_verified_corpus(corpus_dir, "EURUSD")
    _write_verified_corpus(corpus_dir, "GBPUSD")

    calls: list[dict] = []

    def fake_train_offline(dataset_path: str, model_version: str, **kwargs):
        calls.append(
            {
                "dataset_path": dataset_path,
                "model_version": model_version,
                **kwargs,
            }
        )
        artifact = output_dir / f"{model_version}.json"
        metadata = output_dir / f"{model_version}.metadata.json"
        output_dir.mkdir(parents=True, exist_ok=True)
        artifact.write_text("{}", encoding="utf-8")
        metadata.write_text("{}", encoding="utf-8")
        instrument = kwargs["instrument"]
        return {
            "artifact_path": str(artifact),
            "metadata_path": str(metadata),
            "artifact_sha256": f"artifact-{instrument}",
            "dataset_sha256": f"dataset-{instrument}",
            "metrics": {"accuracy": 0.5},
            "approved_for_paper": False,
            "approved_for_live": False,
        }

    monkeypatch.setattr(train_corpus, "train_offline", fake_train_offline)

    report = train_corpus.train_corpus_bundle(
        corpus_dir=corpus_dir,
        output_dir=output_dir,
        bundle_name="candidate-v1",
        timeframe="H1",
    )

    assert report["model_count"] == 2
    assert report["approved_for_paper"] is False
    assert report["approved_for_live"] is False
    routes = {(item["instrument"], item["timeframe"]) for item in report["models"]}
    assert routes == {("EURUSD", "H1"), ("GBPUSD", "H1")}
    assert len(calls) == 2
    assert all(call["approve_for_paper"] is False for call in calls)

    bundle = json.loads(Path(report["bundle_path"]).read_text(encoding="utf-8"))
    assert bundle["bundle_version"] == 1
    assert len(bundle["models"]) == 2
    assert all(not Path(item["artifact_path"]).is_absolute() for item in bundle["models"])


def test_batch_training_rejects_tampered_corpus(tmp_path):
    corpus_dir = tmp_path / "corpus"
    corpus_dir.mkdir()
    dataset = _write_verified_corpus(corpus_dir, "EURUSD")
    dataset.write_text(dataset.read_text(encoding="utf-8") + "\n", encoding="utf-8")

    try:
        train_corpus.train_corpus_bundle(
            corpus_dir=corpus_dir,
            output_dir=tmp_path / "models",
            bundle_name="candidate-v1",
        )
    except ValueError as exc:
        assert "checksum mismatch" in str(exc)
    else:
        raise AssertionError("tampered corpus should be rejected")
