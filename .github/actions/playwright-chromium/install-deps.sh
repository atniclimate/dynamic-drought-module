#!/usr/bin/env bash
set -e

npx playwright install chromium

for attempt in 1 2 3; do
  echo "Playwright OS dependency install attempt $attempt/3"
  if npx playwright install-deps chromium; then
    exit 0
  else
    status=$?
  fi

  if [ "$attempt" -eq 3 ]; then
    echo "Playwright OS dependency install failed after 3 attempts (exit $status)." >&2
    exit "$status"
  fi

  delay=$((attempt * 10))
  echo "Dependency install failed (exit $status); retrying in ${delay}s." >&2
  sleep "$delay"
done
