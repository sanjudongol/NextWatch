// GET /api/config — the public settings the page needs to talk to Supabase.
// (The Supabase URL and anon/publishable key are designed to be public; secrets never leave the server.)
import { env, json } from "../lib/server.js";

export default function handler(req, res) {
  const supabaseUrl = env("SUPABASE_URL");
  const supabaseAnonKey = env("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) return json(res, 200, { ready: false });
  json(res, 200, { ready: true, supabaseUrl, supabaseAnonKey });
}
