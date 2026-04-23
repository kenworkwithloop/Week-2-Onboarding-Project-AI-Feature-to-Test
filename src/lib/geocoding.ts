const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";

export interface GeocodeResult {
  /** Human-readable place for outputs and prompts */
  label: string;
  latitude: number;
  longitude: number;
  population: number;
}

interface RawHit {
  name: string;
  latitude: number;
  longitude: number;
  population?: number;
  country?: string;
  country_code?: string;
  admin1?: string;
}

export async function geocodeFirst(query: string): Promise<GeocodeResult | null> {
  const q = query.trim();
  if (!q) return null;
  const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: RawHit[] };
  const r = data.results?.[0];
  if (r == null || typeof r.latitude !== "number" || typeof r.longitude !== "number") return null;
  const population = typeof r.population === "number" && r.population > 0 ? r.population : 50_000;
  const label = formatPlaceLabel(r);
  return { label, latitude: r.latitude, longitude: r.longitude, population };
}

function formatPlaceLabel(r: RawHit): string {
  const country = r.country ?? r.country_code ?? "";
  if (r.admin1 && country) return `${r.name}, ${r.admin1}, ${country}`;
  if (country) return `${r.name}, ${country}`;
  return r.name;
}
