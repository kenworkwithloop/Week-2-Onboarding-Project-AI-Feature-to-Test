# DeepEval evaluation harness

This folder contains a small Python harness that scores the OmniPlanner agent with [DeepEval](https://docs.confident-ai.com/docs/metrics-introduction). The harness treats the TypeScript agent as a black box: for each test prompt it shells out to `npm run dev -- run <prompt>`, parses the JSON result, and hands it to DeepEval's metrics.

## Setup

Requirements: Python **3.10+** (DeepEval 3.9 uses PEP 604 `X | None` syntax at import time) and a working `npm`/Node setup for the main project.

```bash
cd eval
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Environment variables (reuse the same `.env` as the main app — see the top-level [README](../README.md)):

- `OPENAI_API_KEY` — required. Used both by the agent and by DeepEval's LLM-as-judge metrics.
- `ALPHA_VANTAGE_API_KEY`, `THE_MOVIE_DB_API_KEY`, `CENSUS_API_KEY` — required so the corresponding tool calls (stock / movies / city metrics) don't fail. Missing keys just lower scores for those test cases.

Export them or rely on the app's `.env` — the harness loads `../.env` automatically if present.

## Run

From the repo root:

```bash
python3 eval/run_eval.py
```

or the npm alias:

```bash
npm run eval:deepeval
```

Expect roughly 2–5 minutes: each of the 5 cases runs the agent once and then runs three LLM-as-judge metrics against it.

## Metrics

All DeepEval metrics return a `score` in `[0, 1]` and a natural-language `reason`. A metric "passes" when `score >= threshold` (default `0.5`).

- **Answer Relevancy** (`AnswerRelevancyMetric`) — does the reply actually answer the user's prompt? Low scores flag prompt drift or off-topic responses.
- **Faithfulness** (`FaithfulnessMetric`) — are the factual claims in the reply supported by the `toolCalls` results we pass as `retrieval_context`? Low scores flag hallucination beyond what the tools returned.
- **Correctness** (`GEval`, custom rubric) — does the structured output match the per-case expectation (e.g. itinerary has days, decision report has ≥2 options, chat-only turn has `output: null`)? Low scores flag schema or content regressions the first two metrics can't catch.

## Test cases

Five prompts covering the agent's main modes, defined in [`run_eval.py`](run_eval.py):

1. Chat-only greeting (expects `output: null`).
2. Travel itinerary for a US city (expects `TRAVEL_ITINERARY` with `days[]`).
3. Decision report comparing a stock vs travel (expects `DECISION_REPORT` with ≥2 options and a matching `recommendation`).
4. Movies in a city (expects a reply grounded in TMDb tool output).
5. US city cost-of-living (expects a reply grounded in the Census tool output).

## Reading the output

For each case DeepEval prints:

- the test case input / actual output,
- each metric's score, threshold, pass/fail, and reasoning,
- a final aggregate table with pass rates per metric.

Scores are **indicative**, not strict CI assertions — both the agent and the judge are LLMs, so expect run-to-run variance of a few points. Use the `reason` text to decide whether a low score reflects a real regression or judge noise.
