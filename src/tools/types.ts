export interface WeatherReport {
  temperature: number;
  rain_probability: number;
  conditions: string;
}

export type StockTrend = "up" | "down" | "sideways";

export interface StockReport {
  price: number;
  trend: StockTrend;
  /** Daily-range proxy on [0, 1]: (high - low) / previous_close. Not implied vol. */
  volatility_score: number;
}

export interface MovieListing {
  title: string;
  release_date: string;
  vote_average: number;
  /** Truncated for token size; may be empty. */
  overview: string;
}

/**
 * Theatrical "now playing" for the geocoded place's country (TMDb `region`), not per-venue.
 */
export interface MovieReport {
  /** Resolved place label from geocode (user's prompted location). */
  location: string;
  /** ISO 3166-1 alpha-2 used for TMDb region. */
  region: string;
  movies: MovieListing[];
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
}
