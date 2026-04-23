import { geocodeFirst, type GeocodeResult } from "../lib/geocoding.js";
import type { CityReport } from "./types.js";

/** `fetch` with an AbortSignal deadline; clears the timer when the request settles. */
function fetchWithDeadline(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

const CENSUS_GEOCODER_URL =
  "https://geocoding.census.gov/geocoder/geographies/onelineaddress";
const ACS_VINTAGE = 2022;
const ACS_URL = `https://api.census.gov/data/${ACS_VINTAGE}/acs/acs5`;

/** Census sentinel value for missing/suppressed numeric data. */
const CENSUS_MISSING_SENTINEL = -666666666;

/** Rough US baselines for cost_index normalization (ACS 5-year national medians, documented). */
const US_BASELINE_INCOME_USD = 75_000;
const US_BASELINE_RENT_USD = 1_300;

const DATA_SOURCE =
  "US Census Bureau ACS 5-year (api.census.gov) + Census Geocoder + Open-Meteo geocoding";

/** Hard per-request timeouts: Census Geocoder is flaky and slow, ACS is fast. */
const CENSUS_GEOCODER_TIMEOUT_MS = 6_000;
const ACS_TIMEOUT_MS = 6_000;

interface CensusGeographyHit {
  STATE?: string;
  PLACE?: string;
  COUNTY?: string;
  NAME?: string;
}

interface CensusGeocoderPayload {
  result?: {
    addressMatches?: Array<{
      geographies?: {
        "Incorporated Places"?: CensusGeographyHit[];
        "Counties"?: CensusGeographyHit[];
      };
    }>;
  };
}

interface ResolvedFips {
  state: string;
  place?: string;
  county?: string;
  name?: string;
}

async function resolveUsFips(address: string): Promise<ResolvedFips | null> {
  const params = new URLSearchParams({
    address,
    benchmark: "Public_AR_Current",
    vintage: "Current_Current",
    format: "json",
  });
  const res = await fetchWithDeadline(
    `${CENSUS_GEOCODER_URL}?${params.toString()}`,
    CENSUS_GEOCODER_TIMEOUT_MS,
  );
  if (!res.ok) return null;
  const json = (await res.json()) as CensusGeocoderPayload;
  const match = json.result?.addressMatches?.[0];
  const geographies = match?.geographies;
  if (!geographies) return null;

  const place = geographies["Incorporated Places"]?.[0];
  if (place?.STATE && place.PLACE) {
    return { state: place.STATE, place: place.PLACE, name: place.NAME };
  }
  const county = geographies["Counties"]?.[0];
  if (county?.STATE && county.COUNTY) {
    return { state: county.STATE, county: county.COUNTY, name: county.NAME };
  }
  return null;
}

function parseCensusNumber(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n === CENSUS_MISSING_SENTINEL) return null;
  return n;
}

async function fetchAcsMetrics(
  fips: ResolvedFips,
  key: string,
): Promise<{ income: number | null; rent: number | null }> {
  const params = new URLSearchParams({
    get: "B19013_001E,B25064_001E",
    key,
  });
  if (fips.place) {
    params.set("for", `place:${fips.place}`);
    params.set("in", `state:${fips.state}`);
  } else if (fips.county) {
    params.set("for", `county:${fips.county}`);
    params.set("in", `state:${fips.state}`);
  } else {
    return { income: null, rent: null };
  }

  const res = await fetchWithDeadline(`${ACS_URL}?${params.toString()}`, ACS_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`ACS request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body) || body.length < 2) {
    return { income: null, rent: null };
  }
  const row = body[1] as unknown[];
  return {
    income: parseCensusNumber(row[0]),
    rent: parseCensusNumber(row[1]),
  };
}

/**
 * Normalize rent and income into a 0–100 cost_index.
 * Weights rent > income (rent is the bigger travel/budget lever).
 */
function computeCostIndex(
  income: number | null,
  rent: number | null,
): number | null {
  if (rent == null && income == null) return null;
  const rentRatio =
    rent != null ? rent / US_BASELINE_RENT_USD : 1;
  const incomeRatio =
    income != null ? income / US_BASELINE_INCOME_USD : 1;
  const raw = 0.7 * rentRatio + 0.3 * incomeRatio;
  const scaled = Math.round(raw * 50);
  return Math.max(0, Math.min(100, scaled));
}

function fallbackCostIndex(population: number | undefined): number {
  if (!population || population <= 0) return 50;
  if (population > 5_000_000) return 80;
  if (population > 1_000_000) return 70;
  if (population > 250_000) return 60;
  if (population > 50_000) return 50;
  return 40;
}

function buildAddressForCensus(geo: GeocodeResult, originalCity: string): string {
  // Prefer the resolved label (e.g. "Denver, Colorado, United States") since Census geocoder
  // parses free-form addresses; fall back to the raw user string.
  const label = geo.label?.trim();
  return label && label.length > 0 ? label : originalCity.trim();
}

export async function getCityMetrics(city: string): Promise<CityReport> {
  const trimmed = city.trim();
  if (!trimmed) throw new Error("City must not be empty.");

  const geo = await geocodeFirst(trimmed);
  if (!geo) {
    throw new Error(
      `Could not geocode "${city}". Try a more specific place name.`,
    );
  }

  const base: Omit<CityReport, "cost_index" | "limited"> = {
    location: geo.label,
    country_code: geo.countryCode,
    population: geo.population,
    median_household_income_usd: null,
    median_gross_rent_usd: null,
    data_source: DATA_SOURCE,
  };

  if (geo.countryCode !== "US") {
    return {
      ...base,
      cost_index: fallbackCostIndex(geo.population),
      limited: true,
      note:
        "Full Census metrics are US-only. Returning population-based cost_index; income/rent unavailable outside the US.",
    };
  }

  const key = process.env.CENSUS_API_KEY;
  if (!key?.trim()) {
    return {
      ...base,
      cost_index: fallbackCostIndex(geo.population),
      limited: true,
      note:
        "CENSUS_API_KEY is not set on the server; ACS income/rent unavailable. cost_index is a population-based estimate.",
    };
  }

  const address = buildAddressForCensus(geo, trimmed);
  let fips: ResolvedFips | null = null;
  try {
    fips = await resolveUsFips(address);
  } catch (err) {
    // Census Geocoder is flaky (timeouts, 5xx, DNS). Degrade gracefully so the
    // model doesn't get `{ error }` and start retrying with different city args.
    return {
      ...base,
      cost_index: fallbackCostIndex(geo.population),
      limited: true,
      note: `Census Geocoder request failed (${err instanceof Error ? err.message : String(err)}). cost_index is a population-based estimate.`,
    };
  }
  if (!fips) {
    return {
      ...base,
      cost_index: fallbackCostIndex(geo.population),
      limited: true,
      note:
        "Census Geocoder could not match this address to an incorporated place or county. cost_index is a population-based estimate.",
    };
  }

  try {
    const { income, rent } = await fetchAcsMetrics(fips, key.trim());
    const costIndex = computeCostIndex(income, rent);
    if (costIndex == null) {
      return {
        ...base,
        cost_index: fallbackCostIndex(geo.population),
        limited: true,
        note:
          "ACS returned no median income or rent for this geography. cost_index is a population-based estimate.",
      };
    }
    return {
      ...base,
      median_household_income_usd: income,
      median_gross_rent_usd: rent,
      cost_index: costIndex,
      limited: false,
    };
  } catch (err) {
    return {
      ...base,
      cost_index: fallbackCostIndex(geo.population),
      limited: true,
      note: `ACS request failed (${err instanceof Error ? err.message : String(err)}). cost_index is a population-based estimate.`,
    };
  }
}
