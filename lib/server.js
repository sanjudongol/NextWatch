// Shared helpers for the Vercel functions. No npm packages needed (Node 18+ has fetch).

export const env = (k) => (process.env[k] || "").trim();

// Streaming services we keep, matched against TMDB's US provider names.
// Only "included with subscription" (flatrate) and "free / with ads" offers are used — never rent or buy.
export const SERVICES = [
  ["Netflix", /^netflix( standard with ads)?$/i],
  ["Prime Video", /^amazon prime video( with ads)?$/i],
  ["Disney+", /^disney ?(\+|plus)$/i],
  ["Hulu", /^hulu$/i],
  ["Max", /^(hbo )?max( amazon channel)?$/i],
  ["Apple TV+", /^apple tv ?(\+|plus)$/i],
  ["Peacock", /^peacock( premium( plus)?)?$/i],
  ["Paramount+", /^paramount ?(\+|plus)( essential| premium| with showtime)?$/i],
  ["YouTube", /^youtube( free)?$/i],
];

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// ---------- Supabase (REST) ----------
function sbHeaders(key) {
  const h = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) h.Authorization = "Bearer " + key; // legacy JWT-style keys
  return h;
}
const sbUrl = () => env("SUPABASE_URL").replace(/\/+$/, "");

export async function requireUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(sbUrl() + "/auth/v1/user", {
    headers: { apikey: env("SUPABASE_ANON_KEY"), Authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  return r.json();
}

async function sb(path, init = {}) {
  const r = await fetch(sbUrl() + "/rest/v1/" + path, {
    ...init,
    headers: { ...sbHeaders(env("SUPABASE_SERVICE_ROLE_KEY")), ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Database error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 || init.method === "DELETE" ? null : r.json().catch(() => null);
}
const inList = (ids) => "(" + ids.map((i) => `"${i}"`).join(",") + ")";

export async function freshIds(ids, maxAgeDays = 7) {
  if (!ids.length) return new Set();
  const rows = await sb(`titles?select=id,kind,updated_at,needs:data->needsRatings,lang:data->lang,genres:data->genres,aired:data->aired&id=in.${inList(ids)}`);
  const cutoff = Date.now() - maxAgeDays * 864e5;
  // also re-check animated titles saved before we recorded their language (needed to spot anime)
  const missingLang = (r) => r.lang == null && Array.isArray(r.genres) && r.genres.includes("Animation");
  // and series saved before we tracked seasons (needed for "new season" alerts)
  const missingSeasons = (r) => r.kind === "tv" && r.aired == null;
  return new Set(rows.filter((r) => new Date(r.updated_at).getTime() > cutoff && r.needs !== true && !missingLang(r) && !missingSeasons(r)).map((r) => r.id));
}
export async function staleIds(limit = 15, maxAgeDays = 7) {
  const cutoff = new Date(Date.now() - maxAgeDays * 864e5).toISOString();
  const rows = await sb(`titles?select=id&updated_at=lt.${encodeURIComponent(cutoff)}&order=updated_at.asc&limit=${limit}`);
  return rows.map((r) => r.id);
}
export async function saveTitles(rows) {
  if (!rows.length) return;
  const now = new Date().toISOString();
  await sb("titles", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.map((d) => ({ id: d.id, kind: d.kind, data: d, updated_at: now }))),
  });
}
export async function deleteTitles(ids) {
  if (!ids.length) return;
  await sb(`titles?id=in.${inList(ids)}`, { method: "DELETE" });
}

// ---------- TMDB ----------
export async function tmdb(path) {
  const token = env("TMDB_TOKEN");
  const v4 = token.startsWith("eyJ");
  const url = "https://api.themoviedb.org/3" + path + (v4 ? "" : (path.includes("?") ? "&" : "?") + "api_key=" + token);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: v4 ? { Authorization: "Bearer " + token, accept: "application/json" } : { accept: "application/json" } });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 800 * (attempt + 1))); continue; }
    if (r.status === 401) throw new Error("TMDB rejected the key. Check TMDB_TOKEN in Vercel.");
    if (!r.ok) throw new Error(`TMDB error ${r.status}`);
    return r.json();
  }
  throw new Error("TMDB is rate limiting; try again in a minute.");
}

const providerCache = {};
export async function providerMap(kind) {
  if (providerCache[kind]) return providerCache[kind];
  const d = await tmdb(`/watch/providers/${kind}?watch_region=US&language=en-US`);
  const byId = new Map();
  for (const p of d.results || []) {
    const hit = SERVICES.find(([, re]) => re.test((p.provider_name || "").trim()));
    if (hit) byId.set(p.provider_id, hit[0]);
  }
  return (providerCache[kind] = byId);
}

// ---------- OMDb (IMDb + Rotten Tomatoes scores) ----------
export async function omdb(imdbId) {
  const r = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(env("OMDB_KEY"))}`);
  if (!r.ok) return { failed: true };
  const o = await r.json();
  if (o.Response !== "True") return { failed: /limit|invalid api key/i.test(o.Error || "") };
  const imdb = parseFloat(o.imdbRating);
  const rtRow = (o.Ratings || []).find((x) => x.Source === "Rotten Tomatoes");
  return { imdb: Number.isFinite(imdb) ? imdb : null, rt: rtRow ? parseInt(rtRow.Value, 10) : null };
}

// ---------- building one title ----------
const GENRE_FIX = {
  "Science Fiction": ["Sci-Fi"], "Sci-Fi & Fantasy": ["Sci-Fi", "Fantasy"], "Action & Adventure": ["Action", "Adventure"],
  "War & Politics": ["War", "Politics"], "TV Movie": [], Kids: ["Family"], Soap: ["Drama"], Talk: [], News: [], Reality: ["Reality"],
};
const ONGOING = new Set(["Returning Series", "In Production", "Planned", "Pilot"]);

export async function buildTitle(kind, tmdbId, byId) {
  const id = `${kind}-${tmdbId}`;
  const t = await tmdb(`/${kind}/${tmdbId}?language=en-US&append_to_response=credits,external_ids,watch/providers`);
  const us = (t["watch/providers"] && t["watch/providers"].results && t["watch/providers"].results.US) || {};
  const offers = [...(us.flatrate || []), ...(us.free || []), ...(us.ads || [])];
  const services = [...new Set(offers.map((p) => byId.get(p.provider_id)).filter(Boolean))].sort();
  if (!services.length) return { id, remove: true };

  const imdbId = (t.external_ids && t.external_ids.imdb_id) || t.imdb_id || null;
  let scores = { imdb: null, rt: null }, needsRatings = false;
  if (imdbId) {
    const o = await omdb(imdbId);
    if (o.failed) needsRatings = true; else scores = o;
  }
  const credits = t.credits || {};
  const dirs = kind === "movie"
    ? (credits.crew || []).filter((c) => c.job === "Director").map((c) => c.name)
    : (t.created_by || []).map((c) => c.name);
  const genres = [...new Set((t.genres || []).flatMap((g) => GENRE_FIX[g.name] || [g.name]))];
  const date = t.release_date || t.first_air_date || "";
  let status = null, aired = null, next = null;
  if (kind === "tv") {
    status = t.type === "Miniseries" ? "Limited" : ONGOING.has(t.status) ? "Ongoing" : "Ended";
    // seasons for "new season" alerts: the latest season with an episode out, and the next season if announced
    aired = (t.last_episode_to_air && t.last_episode_to_air.season_number) || 0;
    const ne = t.next_episode_to_air;
    if (ne && ne.season_number > aired) next = { season: ne.season_number, date: ne.air_date || null };
    else if (!ne && status === "Ongoing") {
      const s = (t.seasons || []).filter((x) => x.season_number > aired).sort((a, b) => a.season_number - b.season_number)[0];
      if (s) next = { season: s.season_number, date: s.air_date || null };
    }
  }

  return {
    id, kind, tmdbId, imdbId,
    title: t.title || t.name,
    type: kind === "movie" ? "Movie" : "Series",
    year: +date.slice(0, 4) || null,
    lang: t.original_language || null,
    released: date || null,
    genres,
    imdb: scores.imdb, rt: scores.rt,
    tmdb: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    votes: t.vote_count || 0,
    popularity: Math.round(t.popularity || 0),
    services,
    dirs: dirs.slice(0, 4),
    cast: (credits.cast || []).slice(0, 4).map((c) => c.name),
    len: kind === "movie" ? t.runtime || null : t.number_of_seasons || null,
    status, aired, next,
    summary: (t.overview || "").slice(0, 420),
    poster: t.poster_path ? "https://image.tmdb.org/t/p/w342" + t.poster_path : null,
    needsRatings,
  };
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: String(e.message || e) }; }
    }
  }));
  return out;
}
