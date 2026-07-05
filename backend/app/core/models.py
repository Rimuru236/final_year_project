import os
import joblib
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_registry: dict = {}


def load_models(model_dir: str = "ml_models"):
    """Load all .pkl files once at FastAPI startup."""
    global _registry
    base = Path(model_dir)

    required = ["clf.pkl", "reg.pkl", "le_subject.pkl", "le_topic.pkl", "le_subject2.pkl"]
    for fname in required:
        path = base / fname
        if not path.exists():
            logger.warning(f"Model file not found: {path}. ML features will be degraded.")
            _registry[fname.replace(".pkl", "")] = None
        else:
            key = fname.replace(".pkl", "")
            _registry[key] = joblib.load(path)
            logger.info(f"Loaded {fname}")

    if _registry.get("le_subject"):
        _registry["known_subjects"] = list(_registry["le_subject"].classes_)
    else:
        _registry["known_subjects"] = []

    if _registry.get("le_topic"):
        _registry["known_topics"] = list(_registry["le_topic"].classes_)
    else:
        _registry["known_topics"] = []

    if _registry.get("le_subject2"):
        _registry["known_subjects2"] = list(_registry["le_subject2"].classes_)
    else:
        _registry["known_subjects2"] = []


def get_clf():
    return _registry.get("clf")

def get_reg():
    return _registry.get("reg")

def get_le_subject():
    return _registry.get("le_subject")

def get_le_topic():
    return _registry.get("le_topic")

def get_le_subject2():
    return _registry.get("le_subject2")

def get_known_subjects() -> list[str]:
    return _registry.get("known_subjects", [])

def get_known_topics() -> list[str]:
    return _registry.get("known_topics", [])

def models_ready() -> bool:
    return all(_registry.get(k) is not None for k in ["clf", "reg", "le_subject", "le_topic", "le_subject2"])
