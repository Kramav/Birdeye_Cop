#!/bin/sh
set -e

# Seed the rules file on first run so a fresh container starts instead of
# failing on a missing config. The example contains placeholder rules only.
if [ ! -f /app/config/moderation.json ]; then
  echo "config/moderation.json not found — seeding it from the example (placeholder rules only)."
  cp /app/config/moderation.example.json /app/config/moderation.json
fi

exec "$@"
