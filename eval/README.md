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

### Confident AI (`deepeval view`)

To open the latest eval run in the browser without typing your key every time, persist **`CONFIDENT_API_KEY`** (this is separate from `OPENAI_API_KEY` — it comes from [app.confident-ai.com](https://app.confident-ai.com)):

1. **Recommended:** add one line to the repo-root `.env` or `.env.local` (both are gitignored):

   ```bash
   CONFIDENT_API_KEY=confident_...
   ```

2. **Or** save it via the CLI once (from repo root, venv active or use `npm run deepeval`):

   ```bash
   npm run deepeval -- login --confident-api-key "confident_..." --save=dotenv:.env.local
   ```

DeepEval loads dotenv files from the project directory in order: `.env` → `.env.<APP_ENV>` → `.env.local` (see [environment variables](https://docs.confident-ai.com/docs/environment-variables)).

Open the dashboard for the last run:

```bash
npm run deepeval:view
```

Any other `deepeval` subcommand works the same way, e.g. `npm run deepeval -- login`.

## Run

From the repo root (with the venv activated):

```bash
source eval/.venv/bin/activate
python3 eval/run_eval.py
```

or use the npm script, which runs **`eval/.venv`** Python via [`scripts/deepeval.cjs`](../scripts/deepeval.cjs) so you do not need `deepeval` on your global `python3`:

```bash
npm run eval:deepeval
```

Expect roughly 5–15 minutes: each of the 10 cases runs the agent once and then runs three LLM-as-judge metrics against it.

## Metrics

All DeepEval metrics return a `score` in `[0, 1]` and a natural-language `reason`. A metric "passes" when `score >= threshold` (default `0.5`).

- **Answer Relevancy** (`AnswerRelevancyMetric`) — does the reply actually answer the user's prompt? Low scores flag prompt drift or off-topic responses.
- **Faithfulness** (`FaithfulnessMetric`) — are the factual claims in the reply supported by the `toolCalls` results we pass as `retrieval_context`? Low scores flag hallucination beyond what the tools returned.
- **Correctness** (`GEval`, custom rubric) — checks each case’s rubric against `actual_output` **and** `retrieval_context` (tool ground truth), so titles, dates, and numbers can be verified against what the tools returned.

## Test cases

Ten prompts covering the agent's main modes, defined in [`run_eval.py`](run_eval.py):

1. Chat-only greeting (expects `output: null`).
2. Travel itinerary for a US city (expects `TRAVEL_ITINERARY` with `days[]`).
3. Decision report comparing a stock vs travel (expects `DECISION_REPORT` with ≥2 options and a matching `recommendation`).
4. Movies in Chicago (expects a reply grounded in TMDb tool output).
5. US city cost-of-living — Austin (expects a reply grounded in the Census tool output).
6. Weather-only — Boston tomorrow (`get_weather`, facts match tool).
7. Stock-only — Microsoft quote (`get_stock_data` MSFT, facts match tool).
8. Decision — AAPL vs MSFT (`DECISION_REPORT`, both tickers cited from tools).
9. Movies in London (TMDb UK region, titles grounded in tool rows).
10. Compare Denver vs Phoenix cost signals (one or two `get_city_metrics`, numbers match tools).

## Reading the output

For each case DeepEval prints:

- the test case input / actual output,
- each metric's score, threshold, pass/fail, and reasoning,
- a final aggregate table with pass rates per metric.

Scores are **indicative**, not strict CI assertions — both the agent and the judge are LLMs, so expect run-to-run variance of a few points. Use the `reason` text to decide whether a low score reflects a real regression or judge noise.

## Part 3 – Observability (simulated MCP / Arize-style traces)

Every run of [`run_eval.py`](run_eval.py) also writes a **trace log** per test case, modelling what an MCP/observability layer (Arize, Phoenix, Langfuse) would capture in production: prompt, model output, tool calls, per-metric scores, and timestamps. Nothing leaves the box — traces are plain files under [`../logs/`](../logs/).

### Output files

Each run produces two artifacts named with a UTC run id (e.g. `20260424T151500Z`):

- `logs/eval_observability_<run_id>.jsonl` — one JSON object per case, easy to diff and to stream into future tooling.
- `logs/eval_observability_<run_id>.csv` — the same rows flattened for spreadsheets (one `score.<metric>` column per metric, `model_output` truncated).

Both are gitignored by default via the repo-root `.gitignore`; paste a sample row into a PR description or zip the files for submission.

### Trace schema

```json
{
  "run_id": "20260424T151500Z",
  "case_name": "travel_itinerary_seattle",
  "prompt": "Plan a 3-day weekend trip to Seattle starting this Friday.",
  "model_output": "chat.message: ...\noutput: { ... }",
  "agent_ok": true,
  "agent_error": null,
  "tool_calls": ["get_weather", "get_city_metrics"],
  "scores": {
    "Answer Relevancy": { "score": 0.92, "threshold": 0.5, "success": true, "reason": "...", "error": null },
    "Faithfulness":     { "score": 0.81, "threshold": 0.5, "success": true, "reason": "...", "error": null },
    "Correctness":      { "score": 0.74, "threshold": 0.5, "success": true, "reason": "...", "error": null }
  },
  "aggregate_score": 0.8233,
  "agent_completed_at": "2026-04-24T15:11:20+00:00",
  "eval_completed_at": "2026-04-24T15:14:42+00:00"
}
```

`aggregate_score` is the mean of non-null per-metric scores — a single number to trend for "overall health" while keeping the per-metric breakdown for root-cause analysis.

### Failure case

If the agent subprocess errors (missing API key, Alpha Vantage rate limit, JSON parse failure, timeout), `run_agent` returns `ok: false` and the trace captures it clearly:

- `agent_ok: false`
- `agent_error: "agent produced no stdout (exit=1): ..."`
- `model_output` starts with `AGENT_ERROR: ...` so Correctness and Faithfulness predictably score low

Example row to grep for in a log: `"agent_ok": false`. This is the row you would alert on in production — the agent isn't even getting a chance to be right.

### Edge case

The `chat_only_greeting` case is the interesting edge in the opposite direction: the rubric explicitly allows `output: null` and no tool calls, so `retrieval_context` is effectively empty. Answer Relevancy usually scores very high, but Faithfulness can swing run-to-run because the judge has no grounding to check against. Treat this case as a **judge-noise sentinel**: if it drops while other tool-heavy cases stay stable, you're likely looking at judge variance, not a real regression.

### Detecting drift and degradation

Run the harness on a schedule (nightly or per-PR), keep the JSONL files, and compare the latest run to a rolling baseline:

1. Track `aggregate_score` per `case_name` over time. Alert when it falls more than ~0.15 below the rolling median across several runs (not just one).
2. Track the share of rows with `agent_ok: false`. A jump usually means an upstream API (OpenAI, Alpha Vantage, TMDb, Census) changed or a key expired — infra drift, not model drift.
3. Watch the shape of the degradation: a sustained drop in **Faithfulness** with stable **Answer Relevancy** points at *grounding drift* (the model is fluent but inventing facts); a drop in **Answer Relevancy** with stable **Faithfulness** points at *prompt drift* (the model is technically correct but answering a different question).
4. Spot-check `reason` strings from the metric entries — if they keep naming the same tool (e.g. `get_local_movies` titles absent from retrieval), you have a specific regression to fix.

### What drift would look like here

Drift in this system shows up when the same ten prompts that used to pass start to slide downward run after run without the eval set itself changing. Concretely, you would see `Correctness` and `Faithfulness` drop by 0.1–0.3 across tool-heavy cases — invented movie titles in `movies_now_playing_chicago`, Census numbers that don't match the Census tool result in `city_metrics_austin`, or a `DECISION_REPORT` whose `recommendation` no longer matches any `option.name` in `decision_aapl_vs_msft` — while `Answer Relevancy` stays high because the prose still *sounds* on-topic. That combination (grounded metrics falling, relevancy holding, `agent_ok` still true) is the fingerprint of model or tool-schema drift after an OpenAI model change, a prompt tweak, or an upstream API contract change, and is exactly what the per-case JSONL trail is designed to surface early.
