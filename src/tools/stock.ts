import type { StockReport, StockTrend } from "./types.js";

const QUOTE_URL = "https://www.alphavantage.co/query";

interface GlobalQuotePayload {
  "Global Quote"?: Record<string, string>;
  Note?: string;
  Information?: string;
  "Error Message"?: string;
}

export async function getStockData(symbol: string): Promise<StockReport> {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) {
    throw new Error(
      "ALPHA_VANTAGE_API_KEY is not set. Add it to .env (see .env.example).",
    );
  }

  const normalized = symbol.trim().toUpperCase();
  if (!normalized) throw new Error("Symbol must not be empty.");

  const params = new URLSearchParams({
    function: "GLOBAL_QUOTE",
    symbol: normalized,
    apikey: key,
  });
  const res = await fetch(`${QUOTE_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Alpha Vantage request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as GlobalQuotePayload;
  if (json.Note) throw new Error(`Alpha Vantage rate limit: ${json.Note}`);
  if (json.Information) throw new Error(`Alpha Vantage: ${json.Information}`);
  if (json["Error Message"]) {
    throw new Error(`Alpha Vantage error: ${json["Error Message"]}`);
  }

  const quote = json["Global Quote"];
  if (!quote || Object.keys(quote).length === 0) {
    throw new Error(`No quote returned for symbol "${normalized}".`);
  }

  const price = Number(quote["05. price"]);
  if (!Number.isFinite(price)) {
    throw new Error(`Alpha Vantage returned no numeric price for "${normalized}".`);
  }

  const change = Number(quote["09. change"] ?? "0");
  const high = Number(quote["03. high"] ?? "0");
  const low = Number(quote["04. low"] ?? "0");
  const prevClose = Number(quote["08. previous close"] ?? "0");

  return {
    price,
    trend: classifyTrend(change),
    volatility_score: volatilityScore(high, low, prevClose),
  };
}

function classifyTrend(change: number): StockTrend {
  const epsilon = 0.005;
  if (!Number.isFinite(change)) return "sideways";
  if (change > epsilon) return "up";
  if (change < -epsilon) return "down";
  return "sideways";
}

function volatilityScore(high: number, low: number, prevClose: number): number {
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) {
    return 0;
  }
  if (prevClose <= 0) return 0;
  const range = Math.max(0, high - low);
  return Math.min(1, Math.max(0, range / prevClose));
}
