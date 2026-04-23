export interface WeatherReport {
  temperature: number;
  rain_probability: number;
  conditions: string;
}

export type StockTrend = "up" | "down" | "sideways";

export interface StockReport {
  price: number;
  trend: StockTrend;
  volatility_score: number;
}

export interface MovieListing {
  title: string;
  release_date: string;
  vote_average: number;
  overview: string;
}

export interface MovieReport {
  location: string;
  region: string;
  movies: MovieListing[];
}

/**
 * Federal open data city metrics (Census / Data.gov ecosystem).
 * Full numeric fields are US-only (ACS 5-year via api.census.gov); non-US sets `limited: true`.
 */
export interface CityReport {
  location: string;
  country_code?: string;
  population?: number;
  median_household_income_usd: number | null;
  median_gross_rent_usd: number | null;
  cost_index: number;
  limited: boolean;
  note?: string;
  data_source: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
}
