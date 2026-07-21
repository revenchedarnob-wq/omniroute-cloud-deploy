# 9Router cloud deployment

Render's free 512 MB instance could not keep OmniRoute alive. This wrapper runs
the lighter 9Router 0.5.40 image and performs a one-time migration from the
encrypted OmniRoute backup already stored in Supabase.

The migration preserves the existing client API key, routing combo, aliases,
and supported provider credentials. It maps `agy` to `antigravity` and `zai`
to `glm`. OmniRoute-only web-session providers are skipped.

Runtime SQLite snapshots are encrypted with AES-256-GCM before upload to the
private Supabase bucket. No credentials are stored in this repository.
