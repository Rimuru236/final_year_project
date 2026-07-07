"""
Regression tests for services/model_retrain.py's _fit_and_compare() -- the
sklearn fit/accuracy-guard logic, isolated from the DB-touching example
collection step so it can run against synthetic data and a scratch
directory (never the real ml_models/ files or the live database).
"""
import sys
import os

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.model_retrain import _fit_and_compare, _should_accept, ACCURACY_REGRESSION_TOLERANCE


def _clean_dataset(n_per_class: int = 60) -> pd.DataFrame:
    """
    A perfectly separable synthetic dataset: Weakness_Label is deterministically
    derived from Exam_Score alone, so a RandomForest fits it almost exactly --
    used to get a reliable high-accuracy baseline model.
    """
    subjects = ["Biology", "Chemistry"]
    topics = ["Cells", "Reactions"]
    rows = []
    for i in range(n_per_class):
        # weak examples: low exam score
        rows.append({
            "Subject": subjects[i % 2], "Topic": topics[i % 2],
            "Exam_Score": 20 + (i % 10), "Study_Time": 3.0,
            "Weakness_Label": 1,
        })
        # not-weak examples: high exam score
        rows.append({
            "Subject": subjects[i % 2], "Topic": topics[i % 2],
            "Exam_Score": 80 + (i % 10), "Study_Time": 6.0,
            "Weakness_Label": 0,
        })
    return pd.DataFrame(rows)


def test_should_accept_with_no_existing_model():
    # No prior model to compare against -- always accept.
    assert _should_accept(new_accuracy=0.5, old_accuracy=None) is True


def test_should_accept_improvement_or_tie():
    assert _should_accept(new_accuracy=0.95, old_accuracy=0.90) is True
    assert _should_accept(new_accuracy=0.90, old_accuracy=0.90) is True


def test_should_accept_small_drop_within_tolerance():
    # Exactly at the tolerance boundary (0.95 - 0.03 = 0.92) -- still accepted.
    assert _should_accept(new_accuracy=0.95 - ACCURACY_REGRESSION_TOLERANCE, old_accuracy=0.95) is True


def test_should_reject_drop_beyond_tolerance():
    assert _should_accept(new_accuracy=0.80, old_accuracy=0.95) is False
    # Just a hair past the boundary.
    assert _should_accept(new_accuracy=0.95 - ACCURACY_REGRESSION_TOLERANCE - 0.001, old_accuracy=0.95) is False


def test_retrains_when_no_existing_model(tmp_path):
    result = _fit_and_compare(_clean_dataset(), str(tmp_path))
    assert result["status"] == "retrained"
    assert result["old_accuracy"] is None
    assert result["new_accuracy"] > 0.9
    assert (tmp_path / "clf.pkl").exists()
    assert (tmp_path / "le_subject.pkl").exists()
    assert (tmp_path / "le_topic.pkl").exists()


def test_accepts_comparable_or_better_model(tmp_path):
    # Seed a baseline, then "retrain" again on the exact same clean data --
    # accuracy should be comparable (not a regression), so it should swap in.
    baseline = _fit_and_compare(_clean_dataset(), str(tmp_path))
    assert baseline["status"] == "retrained"

    result = _fit_and_compare(_clean_dataset(), str(tmp_path))
    assert result["status"] == "retrained"
    assert result["old_accuracy"] is not None
