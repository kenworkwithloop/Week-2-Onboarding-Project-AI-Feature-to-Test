"""DeepEval harness for the OmniPlanner agent.

Runs the TypeScript agent as a subprocess for a handful of representative
prompts, wraps each result in an ``LLMTestCase``, and scores them with
Answer Relevancy, Faithfulness, and a G-Eval correctness rubric.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from deepeval import evaluate
from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric, GEval
from deepeval.test_case import LLMTestCase, LLMTestCaseParams

REPO_ROOT = Path(__file__).resolve().parent.parent
AGENT_TIMEOUT_SEC = 180


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


@dataclass(frozen=True)
class EvalCase:
    name: str
    prompt: str
    expected_output: str


CASES: list[EvalCase] = [
    EvalCase(
        name="chat_only_greeting",
        prompt="Hi there, what can you help me with?",
        expected_output=(
            "A friendly 1-3 sentence greeting that briefly lists what the assistant "
            "can help with (travel planning, stock snapshots, movies in theaters, "
            "US city cost signals). The structured output must be null because this "
            "is a chat-only turn."
        ),
    ),
    EvalCase(
        name="travel_itinerary_seattle",
        prompt="Plan a 3-day weekend trip to Seattle starting this Friday.",
        expected_output=(
            "A TRAVEL_ITINERARY with location referencing Seattle, exactly 3 "
            "entries in days[] with ISO YYYY-MM-DD dates in sequence, a positive "
            "integer budget_estimate, and risk_flags that only contain 'rain' if "
            "a weather tool call actually reported rain_probability >= 0.6. The "
            "chat.message should be a short intro or wrap-up, not a day list."
        ),
    ),
    EvalCase(
        name="decision_report_tsla_vs_travel",
        prompt="Should I invest $1000 in TSLA or take a weekend trip to New York City?",
        expected_output=(
            "A DECISION_REPORT with at least two options (one whose name contains "
            "'TSLA', one referencing NYC travel), integer scores in [0, 100], and "
            "a recommendation that exactly matches one of the option names. "
            "chat.message should cite concrete tool facts like price, trend, "
            "volatility_score, temperature, or rain_probability and briefly "
            "explain the tradeoff."
        ),
    ),
    EvalCase(
        name="movies_now_playing_chicago",
        prompt="What movies are playing in theaters in Chicago right now?",
        expected_output=(
            "A chat-only or lightly structured reply that lists a few current "
            "theatrical titles for Chicago's country/region (US), grounded in the "
            "get_local_movies tool output. Titles, release dates, or ratings "
            "mentioned in prose must match the tool result; no invented films."
        ),
    ),
    EvalCase(
        name="city_metrics_austin",
        prompt="How affordable is Austin, Texas? I care about rent and income.",
        expected_output=(
            "A chat reply that cites the get_city_metrics tool output for Austin: "
            "median_household_income_usd, median_gross_rent_usd, and/or "
            "cost_index from the Census ACS data. Numbers quoted in prose must "
            "match the tool result; the reply should acknowledge `limited: true` "
            "caveats if present rather than invent ACS figures."
        ),
    ),
]


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


def _format_retrieval_context(envelope: dict[str, Any]) -> list[str]:
    """Turn each toolCall into a short grounding string for FaithfulnessMetric."""
    tool_calls = envelope.get("toolCalls") or []
    if not tool_calls:
        return ["No tool calls were made for this turn; the reply should be a plain chat response without tool-derived facts."]

    chunks: list[str] = []
    for call in tool_calls:
        name = call.get("name", "<tool>")
        args = call.get("args", {})
        result = call.get("result")
        snippet = json.dumps(result, default=str, ensure_ascii=False)[:2000]
        args_snippet = json.dumps(args, default=str, ensure_ascii=False)[:500]
        chunks.append(f"{name}(args={args_snippet}) -> {snippet}")
    return chunks


def build_test_cases() -> list[LLMTestCase]:
    test_cases: list[LLMTestCase] = []
    for case in CASES:
        print(f"[agent] running case: {case.name} -> {case.prompt!r}", flush=True)
        envelope = run_agent(case.prompt)
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
    return test_cases


def build_metrics() -> list[Any]:
    relevancy = AnswerRelevancyMetric(threshold=0.5, include_reason=True)
    faithfulness = FaithfulnessMetric(threshold=0.5, include_reason=True)
    correctness = GEval(
        name="Correctness",
        criteria=(
            "Determine whether the 'actual output' satisfies the 'expected output' "
            "rubric for the OmniPlanner agent. Penalize: wrong envelope type "
            "(missing or wrong 'output' schema), invented tool data, or ignoring "
            "the user's ask. Reward: correct structured type, dates/fields/ranges "
            "that match the rubric, and a chat.message that matches the stated "
            "tone for the mode."
        ),
        evaluation_params=[
            LLMTestCaseParams.INPUT,
            LLMTestCaseParams.ACTUAL_OUTPUT,
            LLMTestCaseParams.EXPECTED_OUTPUT,
        ],
        threshold=0.5,
    )
    return [relevancy, faithfulness, correctness]


def main() -> int:
    _load_env()
    if not os.environ.get("OPENAI_API_KEY"):
        print("error: OPENAI_API_KEY is required for both the agent and DeepEval judges.", file=sys.stderr)
        return 2

    test_cases = build_test_cases()
    metrics = build_metrics()
    print(f"\n[deepeval] scoring {len(test_cases)} test cases with {len(metrics)} metrics...\n", flush=True)
    evaluate(test_cases=test_cases, metrics=metrics)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
