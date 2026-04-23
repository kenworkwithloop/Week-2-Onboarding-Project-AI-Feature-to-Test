# OmniPlanner Agent

A weather-aware travel chatbot with a stock-quote side hustle. You send a conversation (`messages[]`) and the LLM decides whether to call the `get_weather` or `get_stock_data` tool and whether to reply as a plain CHAT or a structured TRAVEL_ITINERARY. All responses are validated with Zod before they leave the agent. A working network and a valid `OPENAI_API_KEY` are required.

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
  schemas/    Zod schemas: CHAT | TRAVEL_ITINERARY
  cli.ts      `omniplanner run --prompt "..."`
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
| `npm run dev -- run --prompt "hi"` | Run the CLI once via `tsx` (single-message chat) |
| `npm run dev -- run --prompt "Plan a weekend in Seattle"` | Same, produces a TRAVEL_ITINERARY |
| `npm run build && npm start -- run --prompt "..."` | Build, then run from `dist/` |
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
  parsed --> out{"CHAT or TRAVEL_ITINERARY"}
  out --> done["return AgentSuccess"]
```

A single `chat.completions.parse` call carries BOTH `tools` (`get_weather`, `get_stock_data`) and `response_format` (the `AgentOutput` union). When the model calls a tool we execute it, append the result, and loop; when it stops calling tools we return the parsed structured response. Bounded to 20 iterations.

`get_stock_data` wraps Alpha Vantage `GLOBAL_QUOTE` and returns `{ price, trend, volatility_score }`, where `volatility_score` is a simple `(high - low) / previous_close` daily-range proxy clamped to `[0, 1]` — not implied vol.

## Agent contract

Responses conform to the Zod schema in [src/schemas/output.ts](src/schemas/output.ts):

- `CHAT` — `{ type: "CHAT", message: string }`. Small talk, clarifications, short factual answers.
- `TRAVEL_ITINERARY` — `{ type: "TRAVEL_ITINERARY", location, days[], budget_estimate, risk_flags[] }`. Day-by-day plans. `budget_estimate` is an integer USD ballpark; `risk_flags` can only contain `"rain"`.

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
  "toolCalls": [ { "name": "get_weather", "args": {...}, "result": {...}, "duration_ms": 123 } ]
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
