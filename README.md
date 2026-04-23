# OmniPlanner Agent

A weather-aware travel chatbot with a stock-quote side hustle. You send a conversation (`messages[]`) and the LLM may call `get_weather` or `get_stock_data`, then returns **always** `chat: { "message": "..." }` plus **`output`**: a `TRAVEL_ITINERARY`, a `DECISION_REPORT`, or **`null`** on chat-only turns. All responses are validated with Zod. A working network and a valid `OPENAI_API_KEY` are required.

## Stack

- **Node 20+**, TypeScript, ESM, [Zod](https://zod.dev) for output validation
- **Commander** CLI, **Fastify** `/health` + `/chat` endpoints
- **OpenAI** structured outputs + function calling (`gpt-4o-mini` by default)
- **Open-Meteo** geocoding + forecast (no key)
- **Alpha Vantage** `GLOBAL_QUOTE` for stock quotes (free-tier key required; 5 req/min, 25/day)

## Repo layout

```
src/
  agent/      thin runAgent(messages) wrapper
  tools/      Open-Meteo weather tool, Alpha Vantage stock tool, shared types
  lib/        geocoding helper
  llm/        OpenAI chat loop (tools + response_format)
  schemas/    Zod: `chat` + structured `output` (or null)
  cli.ts      `omniplanner run <message words...>`
  server.ts   Fastify HTTP interface
```

## Setup

```bash
npm install
cp .env.example .env
# edit .env and paste your OPENAI_API_KEY
```

`OPENAI_API_KEY` is **required**. If the OpenAI call fails (missing key, quota, network, refusal), the agent returns `{ ok: false, error }` with the message.

`ALPHA_VANTAGE_API_KEY` is **required** for `get_stock_data`. The free tier caps you at ~5 requests/minute and 25/day, so the system prompt tells the model to call the tool at most once per ticker per turn.

Optional env:

- `OPENAI_MODEL` (default `gpt-4o-mini`) — any OpenAI chat model that supports structured outputs + tools.
- `PORT` (default `3000`) — Fastify port.

## Common commands

| Command | What it does |
|---|---|
| `npm run dev -- run hi` | Run the CLI once via `tsx` (single-message chat) |
| `npm run dev -- run Plan a weekend in Seattle` | Same; all words after `run` are the prompt (no quotes required) |
| `npm run build && npm start -- run Compare TSLA and travel to NYC` | Build, then run from `dist/` |
| `npm run serve` | Fastify on `http://localhost:3000` with `GET /health` and `POST /chat` |
| `npm run lint:types` | Strict `tsc --noEmit` type check |

## Flow

```mermaid
flowchart TD
  user["messages[] from client"] --> run["runAgent(messages)"]
  run --> call["OpenAI chat.completions.parse<br/>tools + response_format"]
  call --> dec{"tool_calls?"}
  dec -- yes --> exec["run get_weather<br/>(geocode then forecast)"]
  exec --> append["append tool result"]
  append --> call
  dec -- no --> parsed["message.parsed"]
  parsed --> out["structured output + chat"]
  out --> done["return AgentSuccess"]
```

A single `chat.completions.parse` call carries BOTH `tools` (`get_weather`, `get_stock_data`) and `response_format` (the `AgentOutputEnvelope`: nullable structured `response` + `chat`). When the model calls a tool we execute it, append the result, and loop; when it stops calling tools we return the parsed envelope. Bounded to 24 iterations.

`get_stock_data` wraps Alpha Vantage `GLOBAL_QUOTE` and returns `{ price, trend, volatility_score }`, where `volatility_score` is a simple `(high - low) / previous_close` daily-range proxy clamped to `[0, 1]` — not implied vol.

For `DECISION_REPORT` responses, [src/lib/investmentRules.ts](src/lib/investmentRules.ts) applies a deterministic rule after the model returns: if a stock’s `trend` is `"down"` **and** `volatility_score` **>** `0.7` (i.e. above 70 on a 0–100-style scale), that stock option’s score is reduced by 20 points (clamped to 0–100) and `recommendation` is set to the highest-scoring option’s `name` (stock option names should include the ticker, e.g. `"Invest TSLA"`, so the rule can match tool results).

## Agent contract

Responses conform to the Zod schema in [src/schemas/output.ts](src/schemas/output.ts):

- **`chat`** — always `{ "message": "..." }` (no `type` field). This is the **only** place for conversational prose on chat-only turns. For itineraries it is a short intro/wrap-up; for decisions it explains scores and tradeoffs.
- **`output`** — `TRAVEL_ITINERARY`, `DECISION_REPORT`, or **`null`**. When the user only needs a conversational reply, `output` is `null` and the reply lives entirely in `chat`.
- `TRAVEL_ITINERARY` — `{ type: "TRAVEL_ITINERARY", location, days[], budget_estimate, risk_flags[] }`. `budget_estimate` is an integer USD ballpark; `risk_flags` can only contain `"rain"`.
- `DECISION_REPORT` — `{ type: "DECISION_REPORT", options: [{ name, score }], recommendation }` only (no prose inside `output`).

## HTTP API

### `POST /chat`

Request:

```json
{
  "messages": [
    { "role": "user", "content": "plan a weekend in Seattle" }
  ]
}
```

Multi-turn: keep appending to `messages[]` on the client and send the full history each turn. The last message must have `role: "user"`.

Response (success):

```json
{
  "ok": true,
  "output": { "type": "TRAVEL_ITINERARY", "location": "...", "days": [...], "budget_estimate": 450, "risk_flags": [] },
  "chat": { "message": "Here's a concise intro or wrap-up for the trip..." },
  "toolCalls": [ { "name": "get_weather", "args": {...}, "result": {...}, "duration_ms": 123 } ]
}
```

`chat` is always present. For `DECISION_REPORT`, use `chat.message` for the narrative; keep scores only in `output`.

Chat-only success example:

```json
{
  "ok": true,
  "output": null,
  "chat": { "message": "Hello! How can I help?" },
  "toolCalls": []
}
```

Response (failure): `{ "ok": false, "error": "...", "toolCalls": [...] }` with HTTP 400 for validation errors, 422 for agent errors.

Example with `curl`:

```bash
curl -sS http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi, how are you?"}]}'
```

### `GET /health`

Returns `{ "status": "ok" }`.
