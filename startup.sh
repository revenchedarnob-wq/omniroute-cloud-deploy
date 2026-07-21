#!/bin/sh
set -eu

# Render still has the previous OmniRoute preload in NODE_OPTIONS. It must not
# run inside 9Router, and the old 192 MB heap cap is unnecessarily tight.
unset NODE_OPTIONS
exec /entrypoint.sh node /app/cloud-runner.mjs
