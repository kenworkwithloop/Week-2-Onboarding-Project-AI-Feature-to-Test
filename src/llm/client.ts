import OpenAI from "openai";
import { zodFunction, zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { AgentOutputEnvelope } from "../schemas/output.js";
import type { AgentOutput as AgentOutputT, ChatOutput as ChatOutputT } from "../schemas/output.js";
import type { ToolCall } from "../tools/types.js";
import { geocodeFirst } from "../lib/geocoding.js";
import { getWeather } from "../tools/weather.js";
import { getStockData } from "../tools/stock.js";
import { getLocalMovies } from "../tools/movies.js";
import { getCityMetrics } from "../tools/geocost.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
/** Max chat completions in the tool loop (each can be tool_calls or final parse). */
const MAX_ITERS = 24;
/** After this many completions still returning tool_calls, forbid further tools so the model must emit a final structured reply. */
const FORCE_NO_TOOLS_AFTER_ITER = 7;

export class ChatError extends Error {
  constructor(message: string, public toolCalls: ToolCall[]) {
    super(message);
    this.name = "ChatError";
  }
}

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a helpful assistant for weather-aware travel planning, stock quotes, movies in theaters (by country), and US city cost-of-living signals.

Today's date is ${today} (UTC). Always use dates from today onward; never use dates from your training cutoff.

Tools:
- get_weather(city, date) returns { location, date, temperature (F), rain_probability (0-1), conditions }. Pass null for date to use today.
  * Valid dates are today through ~14 days from today. Do not call get_weather with past dates.
  * Call it whenever the user wants a plan, forecast, or weather-conditional advice. Do not call tools for small talk.
  * For a multi-day itinerary you may call get_weather once per day, or call it once for today and reuse the result across days.
  * If get_weather returns an error, do NOT retry with the same or different past dates; either use a future date or proceed without weather data.
- get_stock_data(symbol) returns { price, trend ("up" | "down" | "sideways"), volatility_score (0-1 daily-range proxy) }.
  * Call it when the user asks about a stock price, trend, or volatility for a specific ticker (e.g. AAPL, MSFT, IBM).
  * Call it at most once per ticker per user turn. Do not retry on rate-limit errors; explain them in chat.message (response null if there is no structured payload).
  * Use the full official ticker; if the user names a company, pick its primary US ticker (e.g. "Apple" -> "AAPL").
- get_local_movies(city) returns { location, region, movies: [{ title, release_date, vote_average, overview }] }. Theatrical "now playing" for the **country** of the geocoded place (same city string the user asked about — pass that trip city or place name). Not per-theater or neighborhood precision.
  * Call when the user asks what is playing, wants cinema ideas, or indoor entertainment for a trip. Use the same city/place wording the user gave (or the itinerary city).
  * Call at most once per distinct city per user turn. Do not retry on API errors; mention them in chat.message.
  * Requires THE_MOVIE_DB_API_KEY on the server.
- get_city_metrics(city) returns { location, country_code, population, median_household_income_usd, median_gross_rent_usd, cost_index (0-100), limited, note, data_source }. Federal open data via US Census ACS 5-year + Census Geocoder (Data.gov ecosystem).
  * Call when the user asks about cost of living, affordability, budget sizing, or wants to compare US cities.
  * US places return ACS income/rent plus a rent-weighted cost_index. Non-US (or missing Census data) sets limited: true and cost_index is a population-based fallback; do not invent ACS numbers for those.
  * Call at most once per distinct city per user turn. Pass the same city/place wording the user gave.
  * Requires CENSUS_API_KEY on the server for full US metrics; without it, limited: true.

Final structured envelope (always both keys): { "response": <structured object or null>, "chat": { "message": string } }. Never omit chat; chat has only the message field (no type discriminator).

Rules for "response" and "chat" (only one place for conversational text — always in chat):
- Chat-only turns (greetings, clarifications, short factual answers, errors explained in words): set response to null. Put the full reply only in chat.message.
- TRAVEL_ITINERARY: response is the full { type, location, days, budget_estimate, risk_flags }. chat.message = 1–3 sentences (intro or wrap-up: trip vibe, weather/budget callouts); do not duplicate day lists in chat.
- DECISION_REPORT: response holds ONLY { type, options, recommendation } — no prose. chat.message = 2–6 sentences citing tool facts (price, trend, volatility_score, rain_probability, temperature), tradeoffs, caveats, why recommendation won.

Variant for "response" when not null (exactly one):
- TRAVEL_ITINERARY: { type: "TRAVEL_ITINERARY", location, days[], budget_estimate, risk_flags[] } — when the user asks for a day-by-day plan.
  * days[].date is an ISO date YYYY-MM-DD starting at ${today} unless the user specified a start date, incrementing by 1 day.
  * days[].plan is one short sentence (<=200 chars) with a specific activity for that city.
  * days[].indoor = true for sheltered activities (museums, galleries, covered markets, indoor shopping).
  * risk_flags may include "rain" only when rain_probability >= 0.6 from get_weather.
  * budget_estimate = integer USD total for the whole trip (lodging + food + light activities), realistic for the destination (major metros cost more than mid-size cities).
- DECISION_REPORT: { type: "DECISION_REPORT", options: [{ name, score }, ...], recommendation } — compare/choose (e.g. stock vs trip, two tickers).
  * Call get_stock_data at most once per ticker and get_weather at most once per city for that decision, then immediately respond with zero tool_calls. Never re-call the same tool with the same arguments to "retry".
  * Call get_stock_data for every stock ticker involved before scoring. If weather matters for travel, call get_weather once for that city (null date = today is fine).
  * options must have at least 2 entries. Each name is a short human-readable label (e.g. "Travel NYC", "Invest TSLA"). Each score is an integer 0–100 from tool results, not invented numbers. Include the ticker substring in stock option names (e.g. "TSLA") so server-side rules can match them.
  * recommendation must exactly match one options[].name. After your reply, the server applies a deterministic investment rule: if get_stock_data shows trend "down" AND volatility_score > 0.7 (70 on a 0–100-style scale), that stock option's score is reduced and recommendation is recomputed as the top-scoring option.`;
}

const GetWeatherArgs = z.object({
  city: z
    .string()
    .min(1)
    .describe("City name to geocode, e.g. 'Seattle' or 'Tokyo Japan'."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe("ISO date YYYY-MM-DD. Pass null to use today."),
});
type GetWeatherArgs = z.infer<typeof GetWeatherArgs>;

const GetStockDataArgs = z.object({
  symbol: z
    .string()
    .min(1)
    .describe("Stock ticker symbol, e.g. 'AAPL', 'MSFT', 'IBM'."),
});
type GetStockDataArgs = z.infer<typeof GetStockDataArgs>;

const GetLocalMoviesArgs = z.object({
  city: z
    .string()
    .min(1)
    .describe(
      "City or place the user asked about (e.g. trip destination). Used to geocode and pick that country's theatrical listings.",
    ),
});
type GetLocalMoviesArgs = z.infer<typeof GetLocalMoviesArgs>;

const GetCityMetricsArgs = z.object({
  city: z
    .string()
    .min(1)
    .describe(
      "User's city or place for cost/metrics lookup (e.g. trip destination). US places return ACS income/rent; non-US returns limited data.",
    ),
});
type GetCityMetricsArgs = z.infer<typeof GetCityMetricsArgs>;

let cachedClient: OpenAI | null | undefined;

function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env (see .env.example).",
    );
  }
  cachedClient = new OpenAI({ apiKey: key });
  return cachedClient;
}

async function runGetWeather(args: GetWeatherArgs) {
  const geo = await geocodeFirst(args.city);
  if (!geo) {
    throw new Error(
      `Could not geocode "${args.city}". Try a more specific place name.`,
    );
  }
  const date = args.date && args.date.length > 0 ? args.date : new Date().toISOString().slice(0, 10);
  const weather = await getWeather(geo, date);
  return { location: geo.label, date, ...weather };
}

export interface ChatInputMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResult {
  output: AgentOutputT;
  /** Always present alongside `output`: `{ message: string }`. */
  chat: ChatOutputT;
  toolCalls: ToolCall[];
}

function toolDedupeKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

export async function runChat(history: ChatInputMessage[]): Promise<ChatResult> {
  const client = getClient();
  const toolCalls: ToolCall[] = [];
  /** Same-turn duplicate tool+args → reuse JSON result string (stops rate-limit hammer / retry loops). */
  const toolResultByKey = new Map<string, string>();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    ...history.map<ChatCompletionMessageParam>((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const tools = [
    zodFunction({
      name: "get_weather",
      parameters: GetWeatherArgs,
      description:
        "Get the daily weather forecast for a city on a given date (defaults to today).",
    }),
    zodFunction({
      name: "get_stock_data",
      parameters: GetStockDataArgs,
      description:
        "Get the latest price, trend, and a daily-range volatility score for a US-listed stock ticker.",
    }),
    zodFunction({
      name: "get_local_movies",
      parameters: GetLocalMoviesArgs,
      description:
        "The Movie Database: now-playing movies for the country of the given city/place (after geocode). Pass the user's location string.",
    }),
    zodFunction({
      name: "get_city_metrics",
      parameters: GetCityMetricsArgs,
      description:
        "Federal open data city metrics (US Census ACS + Census Geocoder): median household income, median gross rent, and a 0-100 cost_index. US places only for full numbers; non-US returns limited data.",
    }),
  ];

  const fail = (msg: string) => new ChatError(msg, toolCalls);

  for (let i = 0; i < MAX_ITERS; i++) {
    const forceNoTools = i >= FORCE_NO_TOOLS_AFTER_ITER;
    const completion = await client.chat.completions.parse({
      model: DEFAULT_MODEL,
      temperature: 0.3,
      messages,
      tools,
      // API requires `tools` whenever `tool_choice` is set; `"none"` blocks further tool calls.
      tool_choice: forceNoTools ? "none" : "auto",
      response_format: zodResponseFormat(AgentOutputEnvelope, "agent_output"),
    });

    const message = completion.choices[0]?.message;
    if (!message) throw fail("OpenAI returned no message.");
    if (message.refusal) {
      throw fail(`OpenAI refused the request: ${message.refusal}`);
    }

    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      if (!message.parsed) {
        throw fail("OpenAI returned no parsed content.");
      }
      return {
        output: message.parsed.response,
        chat: message.parsed.chat,
        toolCalls,
      };
    }

    for (const call of calls) {
      if (call.type !== "function") continue;
      const started = Date.now();
      const argsObj = (call.function.parsed_arguments ?? {}) as Record<string, unknown>;
      const dedupeKey = toolDedupeKey(call.function.name, argsObj);
      const cached = toolResultByKey.get(dedupeKey);
      let contentStr: string;
      let result: unknown;

      if (cached !== undefined) {
        contentStr = cached;
        result = JSON.parse(cached) as unknown;
      } else {
        try {
          if (call.function.name === "get_weather") {
            const args = call.function.parsed_arguments as GetWeatherArgs;
            result = await runGetWeather(args);
          } else if (call.function.name === "get_stock_data") {
            const args = call.function.parsed_arguments as GetStockDataArgs;
            result = await getStockData(args.symbol);
          } else if (call.function.name === "get_local_movies") {
            const args = call.function.parsed_arguments as GetLocalMoviesArgs;
            result = await getLocalMovies(args.city);
          } else if (call.function.name === "get_city_metrics") {
            const args = call.function.parsed_arguments as GetCityMetricsArgs;
            result = await getCityMetrics(args.city);
          } else {
            throw new Error(`Unknown tool: ${call.function.name}`);
          }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        contentStr = JSON.stringify(result);
        toolResultByKey.set(dedupeKey, contentStr);
      }

      toolCalls.push({
        name: call.function.name,
        args: argsObj,
        result,
        duration_ms: Date.now() - started,
      });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: contentStr,
      });
    }
  }

  throw fail(`Agent exceeded ${MAX_ITERS} tool-calling iterations.`);
}
