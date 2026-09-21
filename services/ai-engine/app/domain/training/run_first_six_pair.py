        corpus_manifests[instrument] = corpus
        corpora[instrument] = str(corpus_path)

    qualification_cutoff = _research_qualification_cutoff(corpora)

    horizon_reports: dict[str, Any] = {}
    for horizon in horizons:
        report = evaluate_multi_pair_corpora(
            corpora,
            horizon_bars=horizon,
            report_path=report_dir / f"six_pair_walkforward_{horizon}m.json",
            confidence_threshold=confidence_threshold,
            min_net_return_bps=min_net_return_bps,
            commission_bps=commission_bps,
            slippage_bps=slippage_bps,
            max_splits=max_splits,
            decision_time_before=qualification_cutoff,
            predictions_path=(
                report_dir / f"six_pair_walkforward_{horizon}m_predictions.csv"
            ),
        )
        horizon_reports[f"{horizon}m"] = {
            "report_path": report["report_path"],
            "validation_predictions_path": report.get("validation_predictions_path"),
            "overall": report["overall"],
            "by_instrument": report["by_instrument"],
            "fold_count": report["fold_count"],
            "walk_forward": report["walk_forward"],
            "research_gate": _research_gate(report),
        }

    summary = {
        "report_version": 2,
        "study": "irexpro_initial_six_pair_multitimeframe_walkforward",
        "data_source": normalized_source,
        "instruments": list(INITIAL_FOREX_UNIVERSE),