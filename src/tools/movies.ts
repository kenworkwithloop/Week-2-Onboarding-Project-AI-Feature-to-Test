import { geocodeFirst } from "../lib/geocoding.js";
import type { MovieListing, MovieReport } from "./types.js";

const TMDB_BASE = "https://api.themoviedb.org/3";
const MAX_MOVIES = 10;
const OVERVIEW_MAX = 200;

interface TmdbMovieResult {
  title?: string;
  release_date?: string;
  vote_average?: number;
  overview?: string;
}

interface NowPlayingPayload {
  results?: TmdbMovieResult[];
  success?: boolean;
  status_message?: string;
}

function truncateOverview(text: string): string {
  const t = text.trim();
  if (t.length <= OVERVIEW_MAX) return t;
  return `${t.slice(0, OVERVIEW_MAX - 1)}…`;
}

export async function getLocalMovies(city: string): Promise<MovieReport> {
  const key = process.env.THE_MOVIE_DB_API_KEY;
  if (!key?.trim()) {
    throw new Error(
      "THE_MOVIE_DB_API_KEY is not set. Add it to .env (see .env.example).",
    );
  }

  const geo = await geocodeFirst(city.trim());
  if (!geo) {
    throw new Error(`Could not geocode "${city}". Try a more specific place name.`);
  }

  const region = (geo.countryCode ?? "US").toUpperCase().slice(0, 2);
  const params = new URLSearchParams({
    api_key: key.trim(),
    region,
    page: "1",
  });
  const url = `${TMDB_BASE}/movie/now_playing?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDb request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as NowPlayingPayload;
  if (json.success === false) {
    throw new Error(json.status_message ?? "TMDb returned an error.");
  }

  const raw = json.results ?? [];
  const movies: MovieListing[] = raw.slice(0, MAX_MOVIES).map((m) => ({
    title: typeof m.title === "string" && m.title.length > 0 ? m.title : "Unknown title",
    release_date: typeof m.release_date === "string" ? m.release_date : "",
    vote_average: typeof m.vote_average === "number" && !Number.isNaN(m.vote_average) ? m.vote_average : 0,
    overview: truncateOverview(typeof m.overview === "string" ? m.overview : ""),
  }));

  return {
    location: geo.label,
    region,
    movies,
  };
}
