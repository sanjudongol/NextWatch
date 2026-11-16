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
// Learning sections: each sub-topic is one YouTube search for its most-viewed videos (refreshed weekly).
export const YT_TOPICS = {
  history: { label: "History", subs: {
    world: ["World history", "world history explained"],
    us: ["US history", "american history documentary"],
    ancient: ["Ancient world", "ancient civilizations history"],
    medieval: ["Medieval", "medieval history documentary"],
    wars: ["World wars", "world war 2 history documentary"],
    empires: ["Empires", "rise and fall of empires history"],
    mysteries: ["Mysteries & archaeology", "archaeology mysteries history discovery"],
  } },
  food: { label: "Food & travel", subs: {
    streetfood: ["Street food", "street food tour"],
    cooking: ["Cooking", "cooking recipe how to make"],
    foodtours: ["Food tours", "trying local food travel vlog"],
    destinations: ["Destinations", "travel guide things to do"],
    wonders: ["Amazing places", "most beautiful places in the world travel"],
  } },
  // a third item { days, every } = only videos from the last N days, refreshed every M days (default: all-time, weekly)
  // anyCountry: keep channels from any country (clubs and teams are based all over Europe)
  // soccer searches run in the UK region so "football" means soccer, never the NFL
  soccer: { label: "Soccer", region: "GB", anyCountry: true, not: /\bnfl\b|touchdown|quarterback|super bowl|college football|\bcfb\b|\bncaa\b/i, subs: {
    barca: ["Barcelona", "FC Barcelona", { days: 10, every: 1, must: /barcelona|bar[cç]a/i }],
    lfc: ["Liverpool", "Liverpool FC", { days: 10, every: 1, must: /liverpool|\blfc\b|anfield/i }],
    highlights: ["Latest highlights", "soccer match highlights goals", { days: 7, every: 1 }],
    pl: ["Premier League", "premier league highlights", { days: 7, every: 1, must: /premier league|\bepl\b|\bpl\b|highlights/i }],
    ucl: ["Champions League", "champions league highlights", { days: 14, every: 1, must: /champions league|\bucl\b/i }],
    transfers: ["Transfer news", "football transfer news", { days: 4, every: 1, must: /transfer|sign|deal|bid|here we go|rumou?r/i }],
    fpl: ["FPL", "FPL gameweek tips team selection", { days: 7, every: 1, must: /\bfpl\b|fantasy premier|gameweek|\bgw\s?\d/i }],
    tactics: ["Tactics & analysis", "football tactics explained"],
    goals: ["Best goals", "best football goals of all time"],
    legends: ["Legends", "messi ronaldo best moments"],
    worldcup: ["World Cup", "fifa world cup best moments"],
    skills: ["Skills", "best football skills"],
    stories: ["Stories & documentaries", "football documentary"],
  } },
  // F1: each video goes to the first tab whose title rule it matches, so official "Race Highlights" land under Race
  f1: { label: "F1", anyCountry: true, not: /motogp|moto ?gp|indycar|nascar|f1 ?2[0-9] game|\bf1 ?2[0-9]\b|career mode|league|esports|sim ?racing|fantasy/i, subs: {
    race: ["Race highlights", "F1 race highlights grand prix", { days: 21, every: 1, minViews: 20000, must: /race highlights|extended highlights|grand prix highlights|race recap|driver.?s react after the race/i, mustNot: /sprint|qualifying|fp[123]|practice/i }],
    quali: ["Qualifying", "F1 qualifying highlights", { days: 21, every: 1, minViews: 20000, must: /qualifying|pole lap|quali\b/i, mustNot: /sprint qualifying|sprint shootout/i }],
    sprint: ["Sprint", "F1 sprint highlights", { days: 21, every: 1, minViews: 20000, must: /sprint/i }],
    f1news: ["News & analysis", "F1 news analysis", { days: 7, every: 1, minViews: 20000 }],
    overtakes: ["Best overtakes", "F1 best overtakes of all time"],
    classics: ["Classic races", "F1 greatest races of all time"],
    tech: ["Tech explained", "F1 car technology explained"],
    f1docs: ["Documentaries", "Formula 1 documentary"],
  } },
  // politics: plain, non-partisan searches; the news tabs keep only recent videos from sizable channels
  politics: { label: "Politics", subs: {
    polnews: ["Latest news", "US politics news today", { days: 3, every: 1, minViews: 20000 }],
    polworld: ["World affairs", "world news geopolitics", { days: 7, every: 1, minViews: 20000 }],
    polinterviews: ["Interviews", "political interview", { days: 14, every: 2, minViews: 20000 }],
    poldebates: ["Debates", "political debate full"],
    polexplained: ["Explained", "politics explained"],
  } },
  // podcasts: full episodes only (20+ minutes), so clips and Shorts stay out
  podcasts: { label: "Podcasts", minSecs: 1200, subs: {
    podnew: ["New episodes", "podcast full episode", { days: 7, every: 1, minViews: 50000 }],
    podcomedy: ["Comedy", "comedy podcast full episode"],
    podinterviews: ["Interviews", "long form interview podcast"],
    podcrime: ["True crime", "true crime podcast episode"],
    podscience: ["Science & ideas", "science podcast episode"],
    podsports: ["Sports talk", "sports podcast episode"],
    podbiz: ["Business & money", "business podcast episode"],
  } },
};
// English only: skip videos tagged with another language, or whose title is mostly in another script
const LATIN = /[A-Za-z\u00C0-\u024F]/g, LETTER = /\p{L}/gu;
// regional films and dubbed uploads often carry no language tag and an English-letter title, so catch them by name
export const REGIONAL_RE = /\b(telugu|tamil|malayalam|kannada|hindi|bhojpuri|gujarati|marathi|punjabi|bengali|bangla|odia|urdu|nepali|sinhala|tagalog|dubbed|full (?:hd |youtube |length )?(?:movie|film)|yt film|south indian)\b/i;
const EN_COUNTRIES = new Set(["US", "GB", "CA", "AU", "IE", "NZ"]);
export function isForeign(v, ch) {
  const s = v.snippet || {}, lang = (s.defaultAudioLanguage || s.defaultLanguage || "").toLowerCase();
  if (lang && !lang.startsWith("en") && lang !== "zxx") return true;
  const t = s.title || "", all = (t.match(LETTER) || []).length;
  if (all > 3 && (t.match(LATIN) || []).length / all < 0.7) return true;
  if (REGIONAL_RE.test(t + " " + (s.channelTitle || ""))) return true;
  const c = ch && ch.get(s.channelId); // the uploading channel's own language and country
  if (c && c.lang && !/^en/i.test(c.lang)) return true;
  return !!(c && c.country && !EN_COUNTRIES.has(c.country) && !lang.startsWith("en"));
}
// look up channels (1 quota unit per 50) so every YouTube tab (except club and team channels in Soccer and F1) can skip channels based outside English-speaking countries
async function channels(items) {
  const ids = [...new Set(items.map((v) => (v.snippet || {}).channelId).filter(Boolean))], out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const d = await yt(`channels?part=snippet&id=${ids.slice(i, i + 50).join(",")}`);
      for (const c of d.items || []) out.set(c.id, { lang: (c.snippet || {}).defaultLanguage || "", country: (c.snippet || {}).country || "" });
    } catch { /* if the lookup fails, the other checks still apply */ }
  }
  return out;
}
// kids' videos: YouTube's own "made for kids" flag, plus the big kids' channels and nursery-rhyme titles
export const KIDS_RE = /cocomelon|nursery rhyme|baby shark|kids songs?|songs for (kids|children)|for kids\b|toddler|peppa pig|blippi|ms ?rachel|pinkfong|little baby bum|super simple songs|chuchu|kids diana|vlad (and|&) niki|like nastya|bluey|paw patrol|learn (colors|numbers|abc)/i;
const isKids = (v) => !!((v.status || {}).madeForKids) || KIDS_RE.test(((v.snippet || {}).title || "") + " " + ((v.snippet || {}).channelTitle || ""));
const secs = (iso) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "") || []; return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };

function toTitle(v, extra) {
  const s = v.snippet || {}, st = v.statistics || {};
  const th = s.thumbnails || {};
  const views = +st.viewCount || 0;
  return {
    id: "yt-" + v.id, kind: "yt", type: "Video", title: s.title || "Untitled", channel: s.channelTitle || "", channelId: s.channelId || "",
    year: +(s.publishedAt || "").slice(0, 4) || null, released: (s.publishedAt || "").slice(0, 10) || null,
    genres: [YT_CATS[s.categoryId] || "Other"], views, likes: +st.likeCount || 0, popularity: views,
    secs: secs((v.contentDetails || {}).duration), services: ["YouTube"],
    poster: (th.medium || th.high || th.default || {}).url || null,
    summary: (s.description || "").slice(0, 300), dirs: [], cast: [], lang: s.defaultAudioLanguage || s.defaultLanguage || "", ...extra,
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
    const topic = t.topic || p.topic || null;
    return { id: t.id, kind: "yt", updated_at: now, data: { ...t, alltime: t.alltime || p.alltime || false, trendingAt: t.trendingAt || p.trendingAt || null, topic, sub: t.sub === "podfav" ? p.sub || "podfav" : t.sub || p.sub || null,
      genres: topic && YT_TOPICS[topic] ? [YT_TOPICS[topic].label] : t.genres } };
  });
  const post = (r) => sb("titles", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: clean(r) });
  try { await post(rows); }
  catch (e) { // one odd video shouldn't sink the batch: save them one by one and skip any the database refuses
    let bad = 0;
    for (const r of rows) { try { await post([r]); } catch { bad++; } }
    if (bad === rows.length) throw e;
  }
}
// JSON the database accepts: no null characters or half emoji (a description cut mid-emoji)
const clean = (rows) => JSON.stringify([...new Map(rows.map((r) => [r.id, r])).values()], (k, v) => typeof v === "string" ? v.replace(/\u0000/g, "").toWellFormed() : v);

export async function refreshYouTube({ allTime = "auto" } = {}) {
  if (!env("YOUTUBE_KEY")) return { skipped: "no key" };
  const now = new Date().toISOString(), out = { trending: 0, alltime: 0, errors: [] };
  // 1) trending now: overall plus each category (1 quota unit per call)
  for (const cat of ["", ...Object.keys(YT_CATS)]) {
    try {
      const d = await yt(`videos?part=snippet,statistics,contentDetails,status&chart=mostPopular&regionCode=US&maxResults=${cat ? 20 : 50}${cat ? "&videoCategoryId=" + cat : ""}`);
      const ch = await channels(d.items || []);
      const list = (d.items || []).filter((v) => !isKids(v) && !isForeign(v, ch)).map((v) => toTitle(v, { trendingAt: now }));
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
      const s = await yt(`search?part=id&type=video&order=viewCount&regionCode=US&relevanceLanguage=en&maxResults=50&videoCategoryId=${cat}`);
      const ids = (s.items || []).map((x) => x.id && x.id.videoId).filter(Boolean); // 50 asked, about 25 kept after the English filter
      if (!ids.length) continue;
      const d = await yt(`videos?part=snippet,statistics,contentDetails,status&id=${ids.join(",")}`);
      const ch = await channels(d.items || []);
      const list = (d.items || []).filter((v) => !isKids(v) && !isForeign(v, ch)).slice(0, 25).map((v) => toTitle(v, { alltime: true }));
      await save(list); out.alltime += list.length;
    } catch (e) { out.errors.push(e.message); if (/quota/i.test(e.message)) break; }
  }
  // 3) topic sections (history, food & travel, soccer, F1): searches run side by side, then each video is filed under one tab
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  const jobs = [];
  for (const [topic, def] of Object.entries(YT_TOPICS)) for (const [sub, [, q, o = {}]] of Object.entries(def.subs)) jobs.push({ topic, def, sub, q, o });
  const found = new Map(); // video id -> { v, topic, subs: Set }
  await Promise.all(jobs.map(async ({ topic, def, sub, q, o }) => {
    try {
      if (allTime !== true) {
        const fresh = await sb(`titles?select=id&kind=eq.yt&data->>sub=eq.${sub}&updated_at=gt.${encodeURIComponent(ago((o.every || 7) - 0.1))}&limit=1`);
        if (fresh && fresh.length) return;
      }
      const sr = await yt(`search?part=id&type=video&order=viewCount&regionCode=${def.region || "US"}&relevanceLanguage=en&maxResults=30${o.days ? "&publishedAfter=" + encodeURIComponent(ago(o.days)) : ""}&q=${encodeURIComponent(q)}`);
      const ids = (sr.items || []).map((x) => x.id && x.id.videoId).filter(Boolean);
      if (!ids.length) return;
      const d = await yt(`videos?part=snippet,statistics,contentDetails,status&id=${[...new Set(ids)].join(",")}`);
      const ch = def.anyCountry ? null : await channels(d.items || []);
      for (const v of d.items || []) {
        const sn = v.snippet || {}, text = (sn.title || "") + " " + (sn.channelTitle || "");
        if (isKids(v) || isForeign(v, ch)) continue;
        if ((YT_CATS[sn.categoryId] || "") === "Music" || (def.not && def.not.test(text))) continue;
        if (secs((v.contentDetails || {}).duration) < (def.minSecs || (o.days ? 90 : 180))) continue; // skip Shorts and clips
        if (o.minViews && (+(v.statistics || {}).viewCount || 0) < o.minViews) continue; // skip tiny channels and game sims
        const f = found.get(v.id) || { v, topic, subs: new Set() };
        f.subs.add(sub); found.set(v.id, f);
      }
    } catch (e) { out.errors.push(e.message); }
  }));
  // a video found by several searches goes to the first tab (in menu order) whose title rule fits
  const ok = (t, o) => (!o.must || o.must.test(t)) && (!o.mustNot || !o.mustNot.test(t));
  const list = [];
  for (const { v, topic, subs } of found.values()) {
    const title = (v.snippet || {}).title || "", order = Object.entries(YT_TOPICS[topic].subs);
    const recent = order.some(([k, [, , o = {}]]) => subs.has(k) && o.days);
    // a recent video can move to another recent tab whose title rule fits (e.g. "Race Highlights" found by the sprint search)
    const pick = order.find(([k, [, , o = {}]]) => o.must && ok(title, o) && (subs.has(k) || (recent && o.days)))
      || order.find(([k, [, , o = {}]]) => subs.has(k) && ok(title, o))
      || (recent && order.find(([, [, , o = {}]]) => o.days && !o.must)); // other recent news (practice, reactions) goes to News
    if (pick) list.push(toTitle(v, { topic, sub: pick[0] }));
  }
  for (let i = 0; i < list.length; i += 100) await save(list.slice(i, i + 100));
  for (const t of list) out[t.topic] = (out[t.topic] || 0) + 1;
  await refreshFollows(out);
  return out;
}

// newest uploads from one followed channel (2 quota units): skips Shorts and clips under 4 minutes
export async function refreshChannel(cid) {
  if (!/^UC[\w-]{22}$/.test(cid || "")) return 0;
  const pl = await yt(`playlistItems?part=contentDetails&maxResults=25&playlistId=UU${cid.slice(2)}`);
  const ids = (pl.items || []).map((x) => (x.contentDetails || {}).videoId).filter(Boolean);
  if (!ids.length) return 0;
  const d = await yt(`videos?part=snippet,statistics,contentDetails,status&id=${ids.join(",")}`);
  const list = (d.items || []).filter((v) => !isKids(v) && secs((v.contentDetails || {}).duration) >= 240).map((v) => toTitle(v, { topic: "podcasts", sub: "podfav" }));
  await save(list);
  return list.length;
}
async function refreshFollows(out) {
  const rows = await sb("follows?select=channel_id");
  const ids = [...new Set((rows || []).map((r) => r.channel_id))].slice(0, 60);
  await Promise.all(ids.map(async (c) => { try { out.followed = (out.followed || 0) + await refreshChannel(c); } catch (e) { out.errors.push(e.message); } }));
}

export default async function handler(req, res) {
  try {
    if (!env("YOUTUBE_KEY")) return json(res, 200, { skipped: "no key" });
    if (!(await requireUser(req))) return json(res, 401, { error: "Please sign in again." });
    const follow = (req.body && req.body.follow) || "";
    if (follow) return json(res, 200, { followed: await refreshChannel(follow) }); // just followed: load that channel now
    const out = await refreshYouTube();
    if (out.errors && out.errors.length) console.error("YouTube refresh problems:", out.errors.slice(0, 5).join(" | "));
    return json(res, 200, out);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}
