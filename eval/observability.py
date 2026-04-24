"""Simple file-based trace logger for the DeepEval harness (Part 3).

Each record represents one "trace" per eval case: prompt, model output,
per-metric scores, and timestamps. Kept intentionally dependency-free so
it works from any Python the harness runs under.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any, Iterable, Mapping

_CSV_OUTPUT_MAX_CHARS = 1200


def append_jsonl(path: Path, records: Iterable[Mapping[str, Any]]) -> Path:
    """Write each record as one JSON line. Creates parent dirs if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False, default=str))
            fh.write("\n")
    return path


def traces_to_csv(path: Path, records: Iterable[Mapping[str, Any]]) -> Path:
    """Flatten trace records into a spreadsheet-friendly CSV snapshot."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [_flatten_for_csv(r) for r in records]
    fieldnames = sorted({key for row in rows for key in row.keys()})
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return path


def _flatten_for_csv(record: Mapping[str, Any]) -> dict[str, Any]:
    flat: dict[str, Any] = {}
    for key, value in record.items():
        if key == "scores" and isinstance(value, Mapping):
            for metric_name, metric in value.items():
                score = metric.get("score") if isinstance(metric, Mapping) else None
                flat[f"score.{metric_name}"] = score
            continue
        if key == "model_output" and isinstance(value, str) and len(value) > _CSV_OUTPUT_MAX_CHARS:
            flat[key] = value[:_CSV_OUTPUT_MAX_CHARS] + "...(truncated)"
            continue
        if isinstance(value, (dict, list)):
            flat[key] = json.dumps(value, ensure_ascii=False, default=str)
            continue
        flat[key] = value
    return flat
