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
