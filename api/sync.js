// POST /api/sync?kind=movie|tv&order=top|new&page=N   — pull one page of titles into the catalog
// POST /api/sync?mode=stale                            — refresh the oldest titles (ratings, services)
import { env, json, requireUser, tmdb, providerMap, buildTitle, freshIds, staleIds, saveTitles, deleteTitles, mapLimit } from "../lib/server.js";

const NEEDED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "TMDB_TOKEN", "OMDB_KEY"];

export const NEEDED_ENV = NEEDED;

export default async function handler(req, res) {
  try {
    const missing = NEEDED.filter((k) => !env(k));
    if (missing.length) return json(res, 500, { error: "The site is missing these settings in Vercel: " + missing.join(", ") });
    if (!(await requireUser(req))) return json(res, 401, { error: "Please sign in again." });

    const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
    if (q.mode === "stale") return json(res, 200, await refreshStale());
    return json(res, 200, await syncPage(q));
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}

// One page of TMDB discover results → catalog. Also used by the nightly job (api/cron.js).
export async function syncPage(q) {
    const kind = q.kind === "tv" ? "tv" : "movie";
    const order = q.order === "new" ? "new" : "top";
    const page = Math.max(1, Math.min(20, parseInt(q.page, 10) || 1));
    const genre = /^\d{1,6}([|,]\d{1,6})*$/.test(q.genre || "") ? q.genre : "";  // "|" = any of, "," = all of (99,80 = true crime)  // e.g. 10764 = Reality, 99 = Documentary, 16 = Animation
    const lang = /^[a-z]{2}$/.test(q.lang || "") ? q.lang : "";
    const svc = typeof q.svc === "string" ? q.svc.slice(0, 40) : ""; // one service only (smaller catalogs get crowded out of the big pages)
    const byId = await providerMap(kind);
    const pids = [...byId].filter(([, name]) => !svc || name === svc).map(([pid]) => pid);
    if (!pids.length) return { page, totalPages: 1, checked: 0, skippedFresh: 0, saved: 0, removed: 0 };
    if (!byId.size) throw new Error("Couldn’t match any streaming services on TMDB.");

    const today = new Date().toISOString().slice(0, 10);
    const p = new URLSearchParams({
      watch_region: "US",
      with_watch_providers: pids.join("|"),
      with_watch_monetization_types: "flatrate|free|ads",
      include_adult: "false",
      language: "en-US",
      page: String(page),
    });
    const dateKey = kind === "movie" ? "primary_release_date" : "first_air_date";
    if (order === "top") {
      p.set("sort_by", "vote_count.desc");
      p.set("vote_average.gte", "6.2");
    } else {
      p.set("sort_by", dateKey + ".desc");
      p.set(dateKey + ".lte", today);
      p.set("vote_count.gte", kind === "movie" ? "60" : "30");
      p.set("vote_average.gte", "6.0");
    }
    if (genre) { p.set("with_genres", genre); p.set("vote_average.gte", "5.8"); } // niche shows get fewer votes
    if (lang) p.set("with_original_language", lang);
    const d = await tmdb(`/discover/${kind}?${p}`);
    const results = d.results || [];
    const fresh = await freshIds(results.map((r) => `${kind}-${r.id}`));
    const todo = results.filter((r) => !fresh.has(`${kind}-${r.id}`));
    const built = await mapLimit(todo, 5, (r) => buildTitle(kind, r.id, byId));
    const summary = await store(built);
    return { page, totalPages: Math.min(d.total_pages || 1, 20), checked: results.length, skippedFresh: fresh.size, ...summary };
}

async function store(built) {
  const keep = built.filter((t) => t && !t.remove && !t.error);
  const gone = built.filter((t) => t && t.remove).map((t) => t.id);
  const errors = built.filter((t) => t && t.error).map((t) => t.error);
  await saveTitles(keep);
  await deleteTitles(gone);
  return { saved: keep.length, removed: gone.length, errors: errors.length, firstError: errors[0] || null, ratingsPending: keep.filter((t) => t.needsRatings).length };
}

export async function refreshStale(n = 15) {
  const ids = await staleIds(n);
  const maps = { movie: await providerMap("movie"), tv: await providerMap("tv") };
  const built = await mapLimit(ids, 5, (id) => {
    const [kind, num] = id.split("-");
    return buildTitle(kind, num, maps[kind]);
  });
  return { stale: ids.length, ...(await store(built)) };
}
