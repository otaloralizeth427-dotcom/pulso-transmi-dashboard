// Public by design: Supabase's anon/publishable key is meant to be exposed
// client-side. It can only read the curated read-only views (v_*) -- RLS
// blocks it from every raw table, and it has no write grants anywhere.
// The submissions API key and the Supabase service-role key never appear
// in this app; they only ever live in GitHub Actions secrets.
window.PTM_DASHBOARD_CONFIG = {
  supabaseUrl: "https://mtluuovnlyzohcdwwwmb.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10bHV1b3ZubHl6b2hjZHd3d21iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1ODg1MDQsImV4cCI6MjEwNTE2NDUwNH0.SkEKHOTn9xIINX9cp1QTiNEJiSUBHGJY8tUd9oNDSSo",
  refreshMs: 60000,
};
