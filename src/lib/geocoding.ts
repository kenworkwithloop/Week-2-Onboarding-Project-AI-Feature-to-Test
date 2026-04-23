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

/** Open-Meteo search often misses comma-heavy strings (e.g. "Denver, Colorado"); try fallbacks. */
function geocodeCandidates(raw: string): string[] {
  const q = raw.trim().replace(/\s+/g, " ");
  if (!q) return [];
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim().replace(/\s+/g, " ");
    if (t.length > 0 && !out.includes(t)) out.push(t);
  };
  add(q);
  const comma = q.indexOf(",");
  if (comma > 0) {
    add(q.slice(0, comma));
    add(q.replace(/,/g, " "));
  }
  return out;
}

async function geocodeOnce(name: string): Promise<GeocodeResult | null> {
  const url = `${GEO_URL}?name=${encodeURIComponent(name)}&count=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: RawHit[] };
  const r = data.results?.[0];
  if (r == null || typeof r.latitude !== "number" || typeof r.longitude !== "number") return null;
  const population = typeof r.population === "number" && r.population > 0 ? r.population : 50_000;
  const label = formatPlaceLabel(r);
  return { label, latitude: r.latitude, longitude: r.longitude, population };
}

export async function geocodeFirst(query: string): Promise<GeocodeResult | null> {
  for (const candidate of geocodeCandidates(query)) {
    const hit = await geocodeOnce(candidate);
    if (hit) return hit;
  }
  return null;
}

function formatPlaceLabel(r: RawHit): string {
  const country = r.country ?? r.country_code ?? "";
  if (r.admin1 && country) return `${r.name}, ${r.admin1}, ${country}`;
  if (country) return `${r.name}, ${country}`;
  return r.name;
}
