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

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
}
