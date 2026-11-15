// GET /api/cron — the nightly refresh, started by Vercel Cron (see vercel.json).
// Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else is turned away.
import { env, json } from "../lib/server.js";
import { syncPage, refreshStale, NEEDED_ENV } from "./sync.js";
import { refreshYouTube } from "./youtube.js";

export const config = { maxDuration: 60 };
const BUDGET_MS = 50_000; // stop starting new work after this, so we finish inside the limit

// Newest releases first (that's what changes day to day), then a slice of the top lists, rotating by day.
function jobs() {
  const day = Math.floor(Date.now() / 864e5);
  const rot = (n) => 1 + (day % n);
  return [
    { kind: "movie", order: "new", page: 1 }, { kind: "tv", order: "new", page: 1 },
    { kind: "movie", order: "new", page: 2 }, { kind: "tv", order: "new", page: 2 },
    { kind: "tv", order: "top", page: 1, genre: "10764" }, { kind: "tv", order: "new", page: 1, genre: "10764" }, // reality & competition
    { kind: "tv", order: "top", page: 1, genre: "99" }, { kind: "tv", order: "top", page: 1, genre: "99,80" }, { kind: "tv", order: "top", page: 1, genre: "16", lang: "ja" },
    { kind: "movie", order: "top", page: rot(4), genre: "10751" }, { kind: "tv", order: "top", page: rot(3), genre: "10762" },
    { mode: "stale" }, { mode: "stale" },
    { kind: "movie", order: "top", page: rot(10) }, { kind: "tv", order: "top", page: rot(8) },
    { kind: "tv", order: "top", page: rot(4), genre: "10764" }, { kind: "tv", order: "top", page: rot(4), genre: "16", lang: "ja" },
    { kind: "tv", order: "top", page: rot(3), genre: "99" }, { kind: "movie", order: "top", page: rot(3), genre: "99" },
    { mode: "stale" }, { mode: "stale" }, { mode: "stale" }, { mode: "stale" },
  ];
}

export default async function handler(req, res) {
  const secret = env("CRON_SECRET");
  if (!secret || (req.headers.authorization || "") !== "Bearer " + secret) return json(res, 401, { error: "Not allowed" });
  const missing = NEEDED_ENV.filter((k) => !env(k));
  if (missing.length) return json(res, 500, { error: "Missing settings: " + missing.join(", ") });

  const started = Date.now(), done = [];
  for (const job of jobs()) {
    if (Date.now() - started > BUDGET_MS) break;
    try {
      const r = job.mode === "stale" ? await refreshStale(15) : await syncPage(job);
      done.push({ job, saved: r.saved || 0, removed: r.removed || 0 });
      if (job.mode === "stale" && !r.stale) continue;
    } catch (e) {
      done.push({ job, error: String(e.message || e) });
      if (/rate limit|rejected the key/i.test(String(e.message))) break;
    }
  }
  try { done.push({ job: { youtube: true }, ...(await refreshYouTube()) }); } catch (e) { done.push({ job: { youtube: true }, error: String(e.message || e) }); }
  const saved = done.reduce((n, d) => n + (d.saved || 0), 0);
  console.log("nightly sync", JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), saved, steps: done.length }));
  return json(res, 200, { ok: true, saved, steps: done });
}
