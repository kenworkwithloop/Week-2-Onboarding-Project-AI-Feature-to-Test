export interface WeatherReport {
  temperature: number;
  rain_probability: number;
  conditions: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
}
