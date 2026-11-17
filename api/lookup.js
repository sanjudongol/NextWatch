// POST /api/lookup?q=Wes%20Anderson&role=director|any
// Finds titles that aren't in the catalog yet: a director's (or creator's) work, an actor's work, or titles by name.
// Each one is checked against the streaming services. Titles included with a subscription are kept; titles you can
// only rent or buy are kept too but marked paid, so they show up in search results only.
import { env, json, requireUser, tmdb, providerMap, buildTitle, freshIds, saveTitles, mapLimit } from "../lib/server.js";
import { NEEDED_ENV } from "./sync.js";

export const config = { maxDuration: 60 };
const MAX = 30;

export default async function handler(req, res) {
  try {
    const missing = NEEDED_ENV.filter((k) => !env(k));
    if (missing.length) return json(res, 500, { error: "Missing settings: " + missing.join(", ") });
    if (!(await requireUser(req))) return json(res, 401, { error: "Please sign in again." });
    const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
    const text = String(q.q || "").trim().slice(0, 80);
    const role = q.role === "director" ? "director" : "any";
    if (text.length < 2) return json(res, 400, { error: "Type a little more first." });

    let person = null, picks = []; // picks: [{ kind, id }]
    if (role === "director") {
      const r = (await tmdb(`/search/person?query=${encodeURIComponent(text)}&include_adult=false&language=en-US`)).results || [];
      person = r.find((p) => p.known_for_department === "Directing" || p.known_for_department === "Writing" || p.known_for_department === "Creator") || r[0] || null;
    } else {
      const r = ((await tmdb(`/search/multi?query=${encodeURIComponent(text)}&include_adult=false&language=en-US`)).results || []);
      const first = r[0];
      if (first && first.media_type === "person") person = first;
      else picks = r.filter((x) => x.media_type === "movie" || x.media_type === "tv").slice(0, 10).map((x) => ({ kind: x.media_type, id: x.id }));
    }
    if (person) {
      const c = await tmdb(`/person/${person.id}/combined_credits?language=en-US`);
      const made = (c.crew || []).filter((x) => (x.media_type === "movie" && x.job === "Director") || (x.media_type === "tv" && (x.job === "Creator")));
      const acted = role === "any" ? (c.cast || []).filter((x) => (x.order ?? 99) <= 6 && !(x.genre_ids || []).includes(10767) && !(x.genre_ids || []).includes(10763)) : [];
      const seen = new Set();
      picks = [...made, ...acted]
        .filter((x) => x.media_type === "movie" || x.media_type === "tv")
        .filter((x) => { const k = x.media_type + x.id; if (seen.has(k)) return false; seen.add(k); return true; })
        .filter((x) => (x.release_date || x.first_air_date || "") <= new Date().toISOString().slice(0, 10) && (x.release_date || x.first_air_date))
        .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
        .slice(0, MAX)
        .map((x) => ({ kind: x.media_type, id: x.id }));
    }
    if (!picks.length) return json(res, 200, { person: person && person.name, found: 0, streaming: 0, ids: [] });

    const maps = { movie: await providerMap("movie"), tv: await providerMap("tv") };
    const ids = picks.map((p) => `${p.kind}-${p.id}`);
    const fresh = await freshIds(ids);
    const built = await mapLimit(picks.filter((p) => !fresh.has(`${p.kind}-${p.id}`)), 5, (p) => buildTitle(p.kind, p.id, maps[p.kind], { allowPaid: true }));
    const keep = built.filter((t) => t && !t.remove && !t.error);
    await saveTitles(keep);
    const streamingIds = [...fresh, ...keep.filter((t) => !t.paid).map((t) => t.id)];
    const paid = keep.filter((t) => t.paid).length;
    return json(res, 200, { person: person && person.name, found: picks.length, streaming: streamingIds.length, paid, ids: streamingIds });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}
