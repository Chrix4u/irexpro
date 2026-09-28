"""Export the exact USDJPY 5-minute hybrid candidate for Research PAPER UAT only."""
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
    EVENT_HYBRID_DUAL_DIRECTION_EXPERIMENT_NAME,
    ModelVariant,
    _fit_event_hybrid_dual_direction_for_outer,
)
from app.domain.training.train_multitimeframe import EVENT_LABEL_POLICY, load_and_prepare_corpora

MODEL_TYPE='xgboost_event_pair_bundle'

def sha(path:Path)->str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def schema_hash(cols:list[str])->str:
    return hashlib.sha256(json.dumps(cols,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()

def save(model:Any,path:Path)->dict[str,str]:
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.stem+'.tmp'+path.suffix)
    model.save_model(str(tmp)); tmp.replace(path)
    return {'path':path.name,'sha256':sha(path),'kind':'xgboost_classifier'}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--dataset',required=True); ap.add_argument('--decision-time-before',required=True); ap.add_argument('--output',required=True); ap.add_argument('--horizon-bars',type=int,default=5)
    a=ap.parse_args(); out=Path(a.output)
    pooled, hashes=load_and_prepare_corpora({'USDJPY':a.dataset},horizon_bars=a.horizon_bars,decision_time_before=a.decision_time_before)
    variant=ModelVariant(name='event_barrier_v8_hybrid_dual_direction')
    direction, opportunity, features, counts=_fit_event_hybrid_dual_direction_for_outer(pooled,variant=variant,horizon_bars=a.horizon_bars)
    if list(features)!=list(MULTITIMEFRAME_FEATURE_COLUMNS): raise ValueError('feature schema mismatch')
    root=out.parent; long_spec=save(direction['long'],root/'usdjpy-long.json'); short_spec=save(direction['short'],root/'usdjpy-short.json'); opp_spec=save(opportunity,root/'usdjpy-opportunity.json')
    manifest={
      'bundle_version':1,'model_type':MODEL_TYPE,'experiment':EVENT_HYBRID_DUAL_DIRECTION_EXPERIMENT_NAME,
      'event_label_policy':EVENT_LABEL_POLICY,
      'opportunity':opp_spec,
      'dual_actionability':{'kind':'xgboost_dual_actionability','action_margin_floor':0.10,'long':long_spec,'short':short_spec},
    }
    out.parent.mkdir(parents=True,exist_ok=True); tmp=out.with_suffix(out.suffix+'.tmp'); tmp.write_text(json.dumps(manifest,indent=2,sort_keys=True)); tmp.replace(out)
    now=datetime.now(UTC); version=f'usdjpy-event5-hybrid-research-uat-{now.strftime("%Y%m%dT%H%M%SZ")}'
    metadata={
      'metadata_version':4,'model_type':MODEL_TYPE,'runtime_feature_profile':MULTITIMEFRAME_RUNTIME_PROFILE,
      'research_experiment':EVENT_HYBRID_DUAL_DIRECTION_EXPERIMENT_NAME,'event_label_policy':EVENT_LABEL_POLICY,
      'backtest_evaluation_policy':MULTITIMEFRAME_BACKTEST_POLICY,'research_validation_policy':MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
      'model_version':version,'artifact_sha256':sha(out),'feature_columns':list(MULTITIMEFRAME_FEATURE_COLUMNS),
      'feature_schema_hash':schema_hash(list(MULTITIMEFRAME_FEATURE_COLUMNS)),'feature_count':len(MULTITIMEFRAME_FEATURE_COLUMNS),
      'training_data_source':'HistData Generic ASCII Tick Data (research corpus)','dataset_sha256':hashes,
      'instruments':['USDJPY'],'horizon_bars':a.horizon_bars,'confidence_threshold':0.60,'opportunity_threshold':0.60,
      'direction_threshold':0.50,'action_margin_floor':0.10,'training_counts':counts,
      'validation_status':'research_uat_not_formally_promoted','approved_for_paper':False,'approved_for_sandbox':False,
      'approved_for_live':False,'research_paper_uat_only':True,'sealed_future_holdout_consumed':False,
      'created_at':now.isoformat(),
    }
    mp=out.with_suffix('.metadata.json'); mt=mp.with_suffix(mp.suffix+'.tmp'); mt.write_text(json.dumps(metadata,indent=2,sort_keys=True)); mt.replace(mp)
    print(json.dumps({'model_path':str(out),'metadata_path':str(mp),'model_version':version,'rows':len(pooled),'start':str(pooled.decision_time.min()),'end':str(pooled.decision_time.max()),'approved_for_paper':False,'research_paper_uat_only':True},sort_keys=True))
if __name__=='__main__': main()
