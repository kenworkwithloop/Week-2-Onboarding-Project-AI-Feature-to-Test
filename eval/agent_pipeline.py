"""End-to-end agent eval pipeline.

Four explicit phases run in sequence from a single entrypoint:

1. **Generate** test inputs (deterministic builder, written to disk).
2. **Run** each input through the OmniPlanner agent.
3. **Evaluate** with DeepEval (Answer Relevancy, Faithfulness, Correctness).
4. **Log** observability traces (JSONL + CSV).

Plain Python — no LangChain — kept intentionally small.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from deepeval import evaluate

from cases import CASES, EvalCase
from run_eval import (
    LOGS_DIR,
    REPO_ROOT,
    _aggregate_score,
    _load_env,
    _scores_from_result,
    _utc_now_iso,
    _write_observability_log,
    build_metrics,
    build_test_cases_and_traces,
)

GENERATED_DIR = REPO_ROOT / "eval" / "generated"

# Cheap, reproducible variants on top of the curated baseline so the artifact
# is not just an echo of `cases.py`. Same rubric patterns, swapped subjects.
_PARAMETERIZED_VARIANTS: list[EvalCase] = [
    EvalCase(
        name="stock_quote_aapl",
        prompt="What is Apple's stock price and trend right now?",
        expected_output=(
            "A reply grounded in get_stock_data for AAPL (symbol AAPL). "
            "chat.message should cite price, trend, and/or volatility_score from "
            "the tool; those values must match retrieval_context. output may be "
            "null (chat-only)."
        ),
    ),
    EvalCase(
        name="weather_forecast_seattle",
        prompt="What will the weather be like in Seattle tomorrow?",
        expected_output=(
            "A helpful reply grounded in get_weather for Seattle for a single "
            "future calendar day (tomorrow). Any temperature, rain_probability, "
            "or conditions stated in chat.message must match the tool result in "
            "retrieval_context. output may be null (chat-only)."
        ),
    ),
]


def _phase_header(num: int, total: int, title: str) -> None:
    bar = "=" * 72
    print(f"\n{bar}\nPhase {num}/{total}  {title}\n{bar}", flush=True)


def generate_eval_cases(
    run_id: str,
    *,
    out_dir: Path = GENERATED_DIR,
    verbose: bool = False,
) -> tuple[list[EvalCase], Path]:
    """Build the case list for this run and persist it as a JSON artifact.

    Today this is a deterministic builder: curated baseline + a couple of
    parameterized variants. The shape (`name`, `prompt`, `expected_output`)
    is stable, so swapping in an LLM-backed generator later is a drop-in
    change.
    """
    cases: list[EvalCase] = [*CASES, *_PARAMETERIZED_VARIANTS]
    out_dir.mkdir(parents=True, exist_ok=True)
    artifact = out_dir / f"{run_id}_cases.json"
    payload = {
        "run_id": run_id,
        "generated_at": _utc_now_iso(),
        "count": len(cases),
        "cases": [asdict(c) for c in cases],
    }
    artifact.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"  generated {len(cases)} cases -> {artifact}", flush=True)
    if verbose:
        for c in cases:
            print(f"    - {c.name}: {c.prompt!r}", flush=True)
    else:
        for c in cases:
            print(f"    - {c.name}", flush=True)
    return cases, artifact


def load_cases_from_file(path: Path) -> list[EvalCase]:
    """Read a previously generated artifact so a run can be replayed."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows: Iterable[dict[str, Any]] = raw.get("cases") if isinstance(raw, dict) else raw
    return [EvalCase(**row) for row in rows]


def _print_summary(traces: list[dict[str, Any]]) -> None:
    """Compact per-metric and per-case overview after the run completes."""
    if not traces:
        return
    metric_totals: dict[str, list[float]] = {}
    pass_count = 0
    fail_count = 0
    for trace in traces:
        scores = trace.get("scores") or {}
        for metric_name, payload in scores.items():
            score = payload.get("score") if isinstance(payload, dict) else None
            if isinstance(score, (int, float)):
                metric_totals.setdefault(metric_name, []).append(float(score))
            success = payload.get("success") if isinstance(payload, dict) else None
            if success is True:
                pass_count += 1
            elif success is False:
                fail_count += 1

    print("\nResults:", flush=True)
    name_w = max(len(t.get("case_name") or "") for t in traces)
    for trace in traces:
        agg = trace.get("aggregate_score")
        agg_s = f"{agg:.3f}" if isinstance(agg, (int, float)) else "  -  "
        ok = "ok" if trace.get("agent_ok") else "fail"
        print(f"  {trace['case_name']:<{name_w}}  agent={ok:<4}  score={agg_s}", flush=True)

    if metric_totals:
        print("\nMetric means:", flush=True)
        for metric_name, values in sorted(metric_totals.items()):
            mean = sum(values) / len(values)
            print(f"  {metric_name:<24} {mean:.3f}  (n={len(values)})", flush=True)
    if pass_count or fail_count:
        total = pass_count + fail_count
        print(f"\nThreshold pass rate: {pass_count}/{total}", flush=True)


def run_pipeline(args: argparse.Namespace) -> int:
    _load_env()
    if not os.environ.get("OPENAI_API_KEY"):
        print(
            "error: OPENAI_API_KEY is required for both the agent and DeepEval judges.",
            file=sys.stderr,
        )
        return 2

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print(f"OmniPlanner agent eval pipeline  run_id={run_id}", flush=True)

    _phase_header(1, 4, "Generate test inputs")
    if args.cases:
        cases_path = Path(args.cases)
        cases = load_cases_from_file(cases_path)
        print(f"  loaded {len(cases)} cases from {cases_path}", flush=True)
    else:
        cases, _artifact = generate_eval_cases(run_id, verbose=args.verbose)

    _phase_header(2, 4, f"Run agent on {len(cases)} cases")
    test_cases, traces = build_test_cases_and_traces(cases, verbose=args.verbose)

    _phase_header(3, 4, "Evaluate with DeepEval")
    metrics = build_metrics()
    print(f"  scoring {len(test_cases)} test cases with {len(metrics)} metrics", flush=True)
    result = evaluate(test_cases=test_cases, metrics=metrics)

    _phase_header(4, 4, "Log observability traces")
    scores_by_case = _scores_from_result(result)
    eval_completed_at = _utc_now_iso()
    for trace in traces:
        scores = scores_by_case.get(trace["case_name"], {})
        trace["scores"] = scores
        trace["aggregate_score"] = _aggregate_score(scores)
        trace["eval_completed_at"] = eval_completed_at
        trace["run_id"] = run_id
    _write_observability_log(traces, run_id)

    _print_summary(traces)
    print("\nDone.", flush=True)
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the OmniPlanner agent eval pipeline (generate -> run -> evaluate -> log).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show full prompts and per-case progress lines.",
    )
    parser.add_argument(
        "--cases",
        metavar="PATH",
        help="Load a prior generated cases.json instead of regenerating.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    return run_pipeline(args)


if __name__ == "__main__":
    raise SystemExit(main())
