# PopcornDate

Find well-rated movies and series that are included with your streaming subscriptions (or free with ads on YouTube), never rent or buy.

## What's inside

| File | What it does |
|---|---|
| `index.html` | The app: sign-in, filters, mood presets, partner checks, Surprise me |
| `api/config.js` | Gives the page the public Supabase settings |
| `api/sync.js` | Pulls titles from TMDB and ratings from OMDb into the database |
| `lib/server.js` | Shared server helpers (which services count, how titles are built) |
| `supabase/schema.sql` | Database tables, security rules and partner linking. Run once in Supabase |

No packages to install. Vercel runs it as-is.

## Settings (Vercel → Project → Settings → Environment Variables)

| Name | Where it comes from |
|---|---|
| `TMDB_TOKEN` | TMDB → Settings → API → **API Read Access Token** (the long one) |
| `OMDB_KEY` | The key OMDb emails you (activate it from the email first) |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → **publishable** (or legacy `anon`) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → **secret** (or legacy `service_role`) key. Keep this secret |

After changing settings, redeploy (Vercel → Deployments → ⋯ → Redeploy).

## Supabase sign-in settings

Authentication → URL Configuration → set **Site URL** to your Vercel address (for example `https://watch-finder.vercel.app`) and add the same address under **Redirect URLs**.

## Notes

- The catalog is shared by everyone who uses the site; each person's watched / want / not-interested lists are private, except to a linked partner.
- One full sync uses a few hundred OMDb lookups the first time (free limit: about 1,000 a day). Later syncs only re-check titles older than a week.
- Rotten Tomatoes' audience score (Popcornmeter) isn't available from any official source, so it isn't shown.
- Streaming availability data by JustWatch, via TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.

## Nightly refresh
`vercel.json` schedules `/api/cron` once a day (about 3 am Pacific). It needs a `CRON_SECRET` environment variable in Vercel (any long random string); Vercel sends it automatically, and the endpoint refuses anything without it. Each run spends up to ~50 seconds on new releases, a rotating slice of the top lists, and re-checking the oldest titles.

## Install as an app
The site has a web app manifest and a small service worker, so it can be added to a phone's home screen (Safari → Share → Add to Home Screen, or Chrome → Install app).

## Password reset
"Forgot your password, or never set one?" on the sign-in screen emails a reset link (Supabase `resetPasswordForEmail`). The link returns to the site, which asks for a new password.
