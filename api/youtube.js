// POST /api/youtube — refresh the YouTube section: what's trending now, plus the all-time most-viewed videos.
// Needs YOUTUBE_KEY (a free YouTube Data API v3 key). Called by Sync (signed-in) and by the nightly job.
import { env, json, requireUser } from "../lib/server.js";

export const config = { maxDuration: 60 };
// YouTube's own categories (US): https://developers.google.com/youtube/v3/docs/videoCategories
export const YT_CATS = { 1: "Film & Animation", 10: "Music", 15: "Pets & Animals", 17: "Sports", 20: "Gaming", 23: "Comedy", 24: "Entertainment", 26: "How-to & Style", 27: "Education", 28: "Science & Tech" };

async function yt(path) {
  const r = await fetch("https://www.googleapis.com/youtube/v3/" + path + "&key=" + encodeURIComponent(env("YOUTUBE_KEY")));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("YouTube: " + ((body.error && body.error.message) || r.status));
  return body;
}
const secs = (iso) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "") || []; return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };

function toTitle(v, extra) {
  const s = v.snippet || {}, st = v.statistics || {};
  const th = s.thumbnails || {};
  const views = +st.viewCount || 0;
  return {
    id: "yt-" + v.id, kind: "yt", type: "Video", title: s.title || "Untitled", channel: s.channelTitle || "",
    year: +(s.publishedAt || "").slice(0, 4) || null, released: (s.publishedAt || "").slice(0, 10) || null,
    genres: [YT_CATS[s.categoryId] || "Other"], views, likes: +st.likeCount || 0, popularity: views,
    secs: secs((v.contentDetails || {}).duration), services: ["YouTube"],
    poster: (th.medium || th.high || th.default || {}).url || null,
    summary: (s.description || "").slice(0, 300), dirs: [], cast: [], ...extra,
  };
}

const sbUrl = () => env("SUPABASE_URL").replace(/\/+$/, "");
async function sb(path, init = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const h = { apikey: key, "Content-Type": "application/json", ...(key.startsWith("eyJ") ? { Authorization: "Bearer " + key } : {}) };
  const r = await fetch(sbUrl() + "/rest/v1/" + path, { ...init, headers: { ...h, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Database error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function save(list) {
  if (!list.length) return;
  // keep the "all-time" flag on videos that already had it
  const ids = list.map((t) => `"${t.id}"`).join(",");
  const old = await sb(`titles?select=id,data&id=in.(${ids})`);
  const prev = new Map((old || []).map((r) => [r.id, r.data]));
  const now = new Date().toISOString();
  const rows = list.map((t) => {
    const p = prev.get(t.id) || {};
    return { id: t.id, kind: "yt", updated_at: now, data: { ...t, alltime: t.alltime || p.alltime || false, trendingAt: t.trendingAt || p.trendingAt || null, topic: t.topic || p.topic || null,
      genres: (t.topic || p.topic) === "history" ? ["History"] : t.genres } };
  });
  await sb("titles", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
}

export async function refreshYouTube({ allTime = "auto" } = {}) {
  if (!env("YOUTUBE_KEY")) return { skipped: "no key" };
  const now = new Date().toISOString(), out = { trending: 0, alltime: 0, errors: [] };
  // 1) trending now: overall plus each category (1 quota unit per call)
  for (const cat of ["", ...Object.keys(YT_CATS)]) {
    try {
      const d = await yt(`videos?part=snippet,statistics,contentDetails&chart=mostPopular&regionCode=US&maxResults=${cat ? 20 : 50}${cat ? "&videoCategoryId=" + cat : ""}`);
      const list = (d.items || []).map((v) => toTitle(v, { trendingAt: now }));
      await save(list); out.trending += list.length;
    } catch (e) { if (!/not found|invalid|not supported/i.test(e.message)) out.errors.push(e.message); }
  }
  // 2) all-time most viewed per category: search is expensive (100 units), so only weekly
  let doAll = allTime === true;
  if (allTime === "auto") {
    const recent = await sb(`titles?select=id&kind=eq.yt&data->>alltime=eq.true&updated_at=gt.${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}&limit=1`);
    doAll = !(recent && recent.length);
  }
  if (doAll) for (const cat of Object.keys(YT_CATS)) {
    try {
      const s = await yt(`search?part=id&type=video&order=viewCount&regionCode=US&maxResults=25&videoCategoryId=${cat}`);
      const ids = (s.items || []).map((x) => x.id && x.id.videoId).filter(Boolean);
      if (!ids.length) continue;
      const d = await yt(`videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`);
      const list = (d.items || []).map((v) => toTitle(v, { alltime: true }));
      await save(list); out.alltime += list.length;
    } catch (e) { out.errors.push(e.message); if (/quota/i.test(e.message)) break; }
  }
  // 3) learning: the most-viewed history videos (weekly, with the all-time pass)
  if (doAll) for (const q of ["history", "history documentary", "ancient history", "world war history"]) {
    try {
      const sr = await yt(`search?part=id&type=video&order=viewCount&regionCode=US&relevanceLanguage=en&maxResults=25&videoDuration=medium&q=${encodeURIComponent(q)}`);
      const sl = await yt(`search?part=id&type=video&order=viewCount&regionCode=US&relevanceLanguage=en&maxResults=15&videoDuration=long&q=${encodeURIComponent(q)}`);
      const ids = [...(sr.items || []), ...(sl.items || [])].map((x) => x.id && x.id.videoId).filter(Boolean);
      if (!ids.length) continue;
      const d = await yt(`videos?part=snippet,statistics,contentDetails&id=${[...new Set(ids)].join(",")}`);
      const list = (d.items || []).filter((v) => (YT_CATS[(v.snippet || {}).categoryId] || "") !== "Music")
        .map((v) => toTitle(v, { alltime: true, topic: "history" }));
      list.forEach((t) => { t.genres = ["History"]; });
      await save(list); out.history = (out.history || 0) + list.length;
    } catch (e) { out.errors.push(e.message); if (/quota/i.test(e.message)) break; }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (!env("YOUTUBE_KEY")) return json(res, 200, { skipped: "no key" });
    if (!(await requireUser(req))) return json(res, 401, { error: "Please sign in again." });
    return json(res, 200, await refreshYouTube());
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}
