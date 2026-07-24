# 9Router cloud deployment

Render's free 512 MB instance could not keep OmniRoute alive. This wrapper runs
the lighter 9Router 0.5.40 image and performs a one-time migration from the
encrypted OmniRoute backup already stored in Supabase.

The migration preserves the existing client API key, routing combo, aliases,
and supported provider credentials. It maps `agy` to `antigravity` and `zai`
to `glm`. OmniRoute-only web-session providers are skipped.

Runtime SQLite snapshots are encrypted with AES-256-GCM before upload to the
private Supabase bucket. No credentials are stored in this repository.

The base image is pinned to the production-observed 9Router v0.5.40 digest.
Files under `overrides/open-sse/` are a focused overlay from upstream source
commit `79918c7830695bbca4a45c9fea4a42c3e9fd73d1` that bridges client-executed
Responses deferred tools through OpenAI Chat-compatible providers.
