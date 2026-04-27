"""DeepEval harness for the OmniPlanner agent.

Runs the TypeScript agent as a subprocess for ten representative
prompts, wraps each result in an ``LLMTestCase``, and scores them with
Answer Relevancy, Faithfulness, and a G-Eval correctness rubric.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from deepeval import evaluate
from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric, GEval
from deepeval.test_case import LLMTestCase, LLMTestCaseParams

from cases import CASES, EvalCase
from observability import append_jsonl, traces_to_csv

REPO_ROOT = Path(__file__).resolve().parent.parent
LOGS_DIR = REPO_ROOT / "logs"
AGENT_TIMEOUT_SEC = 180
# Max characters per retrieval_context string for generic JSON (movies use per-title rows).
_RETRIEVAL_CHUNK = 7500


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load_env() -> None:
    """Load the app's .env so OPENAI_API_KEY and tool keys are visible."""
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _pick_runner() -> list[str]:
    """Prefer the built dist if present, else fall back to `npm run dev`."""
    dist_cli = REPO_ROOT / "dist" / "cli.js"
    if dist_cli.exists():
        node = shutil.which("node") or "node"
        return [node, str(dist_cli)]
    npm = shutil.which("npm") or "npm"
    return [npm, "run", "dev", "--silent", "--"]


def run_agent(prompt: str) -> dict[str, Any]:
    """Invoke the agent CLI and return the parsed JSON envelope."""
    cmd = [*_pick_runner(), "run", prompt]
    result = subprocess.run(
        cmd,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=AGENT_TIMEOUT_SEC,
        check=False,
    )
    stdout = result.stdout.strip()
    if not stdout:
        return {
            "ok": False,
            "error": f"agent produced no stdout (exit={result.returncode}): {result.stderr.strip()[:500]}",
            "chat": {"message": ""},
            "output": None,
            "toolCalls": [],
        }

    # The CLI prints one JSON object; tolerate leading log lines by finding the
    # first '{' and parsing from there.
    start = stdout.find("{")
    payload = stdout[start:] if start >= 0 else stdout
    try:
        return json.loads(payload)
    except json.JSONDecodeError as err:
        return {
            "ok": False,
            "error": f"failed to parse agent stdout: {err}",
            "chat": {"message": stdout[:500]},
            "output": None,
            "toolCalls": [],
        }


def _format_actual_output(envelope: dict[str, Any]) -> str:
    """Flatten the agent envelope into a single string the judge can read."""
    if not envelope.get("ok", False):
        return f"AGENT_ERROR: {envelope.get('error', 'unknown error')}"
    chat_message = (envelope.get("chat") or {}).get("message", "")
    structured = envelope.get("output")
    structured_line = json.dumps(structured, default=str, ensure_ascii=False)
    return f"chat.message: {chat_message}\noutput: {structured_line}"


def _dedupe_tool_calls(tool_calls: list[Any]) -> list[Any]:
    """Drop identical tool name+args+result rows (model sometimes repeats calls)."""
    seen: set[str] = set()
    out: list[Any] = []
    for call in tool_calls:
        key = json.dumps(
            {"name": call.get("name"), "args": call.get("args"), "result": call.get("result")},
            sort_keys=True,
            default=str,
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(call)
    return out


def _chunks_for_movie_tool(name: str, args: dict[str, Any], result: Any) -> list[str]:
    """One row per title so Faithfulness sees the full now-playing list (no mid-JSON cut)."""
    if not isinstance(result, dict):
        return []
    movies = result.get("movies")
    if not isinstance(movies, list):
        return []
    header = {k: v for k, v in result.items() if k != "movies"}
    args_s = json.dumps(args, default=str, ensure_ascii=False)
    lines = [
        f"{name}(args={args_s}) location header: "
        f"{json.dumps(header, default=str, ensure_ascii=False)}"
    ]
    for i, m in enumerate(movies):
        if not isinstance(m, dict):
            continue
        row = {
            "title": m.get("title"),
            "release_date": m.get("release_date"),
            "vote_average": m.get("vote_average"),
        }
        lines.append(f"{name} row[{i}]: {json.dumps(row, ensure_ascii=False)}")
    return lines


def _chunks_for_generic_tool(name: str, args: dict[str, Any], result: Any) -> list[str]:
    """Full JSON, split across multiple retrieval_context strings if huge."""
    args_s = json.dumps(args, default=str, ensure_ascii=False)
    body = json.dumps(result, default=str, ensure_ascii=False)
    prefix = f"{name}(args={args_s}) -> "
    if len(prefix) + len(body) <= _RETRIEVAL_CHUNK:
        return [prefix + body]
    chunks: list[str] = []
    step = max(4000, _RETRIEVAL_CHUNK - len(prefix) - 40)
    for start in range(0, len(body), step):
        part = body[start : start + step]
        label = f"{name} result[{start}:{start + len(part)}]"
        chunks.append(f"{label}: {part}")
    return chunks


def _format_retrieval_context(envelope: dict[str, Any]) -> list[str]:
    """Turn each toolCall into grounding strings for FaithfulnessMetric."""
    tool_calls = _dedupe_tool_calls(list(envelope.get("toolCalls") or []))
    if not tool_calls:
        return ["No tool calls were made for this turn; the reply should be a plain chat response without tool-derived facts."]

    chunks: list[str] = []
    for call in tool_calls:
        name = str(call.get("name") or "<tool>")
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        result = call.get("result")
        if name == "get_local_movies":
            movie_chunks = _chunks_for_movie_tool(name, args, result)
            if movie_chunks:
                chunks.extend(movie_chunks)
                continue
        chunks.extend(_chunks_for_generic_tool(name, args, result))
    return chunks


def build_test_cases_and_traces(
    cases: list[EvalCase] | None = None,
    *,
    verbose: bool = False,
) -> tuple[list[LLMTestCase], list[dict[str, Any]]]:
    """Run the agent once per case, returning DeepEval cases and trace rows."""
    case_list = list(cases) if cases is not None else CASES
    test_cases: list[LLMTestCase] = []
    traces: list[dict[str, Any]] = []
    total = len(case_list)
    width = max(len(c.name) for c in case_list) if case_list else 0
    for idx, case in enumerate(case_list, start=1):
        if verbose:
            print(f"[agent] ({idx}/{total}) {case.name} -> {case.prompt!r}", flush=True)
        else:
            print(f"  [{idx:>2}/{total}] {case.name:<{width}}  ...", end="", flush=True)
        started = datetime.now(timezone.utc)
        envelope = run_agent(case.prompt)
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        ok = bool(envelope.get("ok", False))
        if not verbose:
            status = "ok" if ok else "fail"
            print(f" {status} ({elapsed:0.1f}s)", flush=True)
        actual = _format_actual_output(envelope)
        context = _format_retrieval_context(envelope)
        test_cases.append(
            LLMTestCase(
                name=case.name,
                input=case.prompt,
                actual_output=actual,
                expected_output=case.expected_output,
                retrieval_context=context,
            )
        )
        traces.append(
            {
                "case_name": case.name,
                "prompt": case.prompt,
                "model_output": actual,
                "agent_ok": ok,
                "agent_error": envelope.get("error"),
                "agent_elapsed_sec": round(elapsed, 3),
                "tool_calls": [
                    call.get("name") for call in (envelope.get("toolCalls") or [])
                    if isinstance(call, dict) and call.get("name")
                ],
                "agent_completed_at": _utc_now_iso(),
            }
        )
    return test_cases, traces


def build_metrics() -> list[Any]:
    relevancy = AnswerRelevancyMetric(threshold=0.5, include_reason=True)
    faithfulness = FaithfulnessMetric(threshold=0.5, include_reason=True)
    correctness = GEval(
        name="Correctness",
        criteria=(
            "Determine whether the 'actual output' satisfies the 'expected output' "
            "rubric for the OmniPlanner agent. When 'retrieval_context' is non-empty, "
            "use it as ground truth for tool-backed facts (movie titles/dates, "
            "weather numbers, stock fields, Census fields). Penalize claims that "
            "contradict retrieval_context or titles/dates not found there when the "
            "rubric requires grounding. Penalize wrong structured 'output' type "
            "when the rubric requires TRAVEL_ITINERARY or DECISION_REPORT. Do not "
            "penalize 'output: null' when the expected rubric explicitly allows a "
            "chat-only turn. Reward: schema when required, accurate tool alignment, "
            "and chat.message tone per the rubric."
        ),
        evaluation_params=[
            LLMTestCaseParams.INPUT,
            LLMTestCaseParams.ACTUAL_OUTPUT,
            LLMTestCaseParams.EXPECTED_OUTPUT,
            LLMTestCaseParams.RETRIEVAL_CONTEXT,
        ],
        threshold=0.5,
    )
    return [relevancy, faithfulness, correctness]


def _scores_from_result(result: Any) -> dict[str, dict[str, dict[str, Any]]]:
    """Index evaluate()'s TestResult list by case name -> { metric: {score, ...} }."""
    indexed: dict[str, dict[str, dict[str, Any]]] = {}
    for test_result in getattr(result, "test_results", []) or []:
        name = getattr(test_result, "name", None)
        if not name:
            continue
        per_metric: dict[str, dict[str, Any]] = {}
        for metric in getattr(test_result, "metrics_data", None) or []:
            per_metric[metric.name] = {
                "score": metric.score,
                "threshold": metric.threshold,
                "success": metric.success,
                "reason": metric.reason,
                "error": metric.error,
            }
        indexed[name] = per_metric
    return indexed


def _aggregate_score(per_metric: dict[str, dict[str, Any]]) -> float | None:
    """Mean of non-null metric scores; None if no scores exist."""
    values = [m["score"] for m in per_metric.values() if isinstance(m.get("score"), (int, float))]
    return round(sum(values) / len(values), 4) if values else None


def _write_observability_log(traces: list[dict[str, Any]], run_id: str) -> Path:
    jsonl_path = LOGS_DIR / f"eval_observability_{run_id}.jsonl"
    csv_path = LOGS_DIR / f"eval_observability_{run_id}.csv"
    append_jsonl(jsonl_path, traces)
    traces_to_csv(csv_path, traces)
    print(f"\n[observability] wrote {len(traces)} trace rows")
    print(f"  json: {jsonl_path}")
    print(f"   csv: {csv_path}")
    return jsonl_path


def main() -> int:
    """Backwards-compatible entrypoint: delegate to the full pipeline."""
    from agent_pipeline import main as pipeline_main

    return pipeline_main([])


if __name__ == "__main__":
    raise SystemExit(main())
