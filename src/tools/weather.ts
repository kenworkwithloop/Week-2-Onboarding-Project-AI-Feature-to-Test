import type { GeocodeResult } from "../lib/geocoding.js";
import type { WeatherReport } from "./types.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

interface DailyForecastPayload {
  daily?: {
    time?: string[];
    weather_code?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
  };
}

/**
 * get_weather(city, date) -> WeatherReport
 *
 * City is passed as a pre-resolved geocode so callers don't duplicate geocoding.
 * Hits Open-Meteo's daily forecast; throws a descriptive error on failure.
 */
export async function getWeather(geo: GeocodeResult, date: string): Promise<WeatherReport> {
  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    daily: "weather_code,precipitation_probability_max,temperature_2m_max,temperature_2m_min",
    timezone: "auto",
    start_date: date,
    end_date: date,
    temperature_unit: "fahrenheit",
  });
  const res = await fetch(`${FORECAST_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as DailyForecastPayload;
  const daily = json.daily;
  if (!daily?.time?.length) {
    throw new Error(`Open-Meteo returned no daily data for ${geo.label} on ${date}.`);
  }

  let idx = daily.time.indexOf(date);
  if (idx < 0 && daily.time.length === 1) idx = 0;
  if (idx < 0) {
    throw new Error(`Open-Meteo did not include ${date} in the response.`);
  }

  const code = daily.weather_code?.[idx] ?? 0;
  const tMax = daily.temperature_2m_max?.[idx];
  const tMin = daily.temperature_2m_min?.[idx];
  const temperature =
    tMax != null && tMin != null
      ? (tMax + tMin) / 2
      : tMax != null
        ? tMax
        : tMin != null
          ? tMin
          : 70;

  return {
    temperature: Number(temperature),
    rain_probability: rainProbability(code, daily.precipitation_probability_max?.[idx]),
    conditions: wmoToConditions(code),
  };
}

function rainProbability(code: number, precipMaxPercent: number | null | undefined): number {
  if (typeof precipMaxPercent === "number" && !Number.isNaN(precipMaxPercent)) {
    return Math.min(1, Math.max(0, precipMaxPercent / 100));
  }
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)) return 0.7;
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 0.5;
  if ([45, 48].includes(code)) return 0.25;
  return 0.1;
}

/** WMO codes: https://open-meteo.com/en/docs */
function wmoToConditions(code: number): string {
  if (code === 0) return "sunny";
  if (code === 1) return "mostly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "foggy";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rainy";
  if (code >= 71 && code <= 77) return "snowy";
  if (code >= 80 && code <= 82) return "rainy";
  if (code === 85 || code === 86) return "snowy";
  if (code >= 95 && code <= 99) return "thunderstorm";
  return "clear";
}
