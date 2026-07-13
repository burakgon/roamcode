#!/usr/bin/env bash
# RoamCode bootstrap. The durable implementation lives in the published CLI so curl, npx and Homebrew
# all install the exact same managed runtime instead of maintaining three different installers.
set -euo pipefail

die() { printf 'roamcode: %s\n' "$1" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die "Node.js >= 24 is required (https://nodejs.org)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf 0)"
[ "$NODE_MAJOR" -ge 24 ] || die "Node.js >= 24 is required (found $(node --version))."
command -v npx >/dev/null 2>&1 || die "npx is required (it is included with Node.js)."

if ! command -v tmux >/dev/null 2>&1; then
  printf 'roamcode: warning: tmux is required for sessions (macOS: brew install tmux).\n' >&2
fi

exec npx --yes roamcode@latest install
