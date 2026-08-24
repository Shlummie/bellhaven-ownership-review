#!/bin/sh
set -eu

# This wrapper is intended for a dedicated, unprivileged service account.
# It keeps runtime state and the token outside the source checkout, prevents
# overlapping scheduled scans, and bounds the maximum runtime.
umask 077

project_dir="${BELLHAVEN_PROJECT_DIR:-/opt/bellhaven-ownership-review}"
runtime_dir="${BELLHAVEN_RUNTIME_DIR:-/var/lib/bellhaven-ownership-review}"
config_path="${BELLHAVEN_CONFIG_PATH:-/etc/bellhaven-ownership-review/.env.local}"
npm_bin="${BELLHAVEN_NPM_BIN:-/usr/bin/npm}"

if [ ! -d "$project_dir" ]; then
  echo "Bellhaven project directory does not exist: $project_dir" >&2
  exit 72
fi
if [ ! -x "$npm_bin" ]; then
  echo "Bellhaven npm executable is unavailable: $npm_bin" >&2
  exit 69
fi

mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"

if [ ! -f "$config_path" ] && [ -z "${CRM_API_TOKEN:-}" ]; then
  echo "Bellhaven CRM configuration is missing: $config_path" >&2
  exit 78
fi

export BELLHAVEN_RUNTIME_DIR="$runtime_dir"
export BELLHAVEN_CONFIG_PATH="$config_path"
export REVIEW_STATE_PATH="${REVIEW_STATE_PATH:-$runtime_dir/review-state.json}"

cd "$project_dir"
exec /usr/bin/flock --exclusive --nonblock --conflict-exit-code 75 \
  "$runtime_dir/pipeline.lock" \
  /usr/bin/timeout --signal=TERM --kill-after=30s 15m \
  "$npm_bin" run pipeline
