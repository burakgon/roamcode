#!/usr/bin/env bash
# RoamCode bootstrap. The durable implementation lives in the published CLI so curl, npx and Homebrew
# all install the exact same managed runtime instead of maintaining three different installers.
set -euo pipefail

die() { printf 'roamcode: %s\n' "$1" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die "Node.js >= 24 is required. Install it from https://nodejs.org, then rerun this command."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf 0)"
[ "$NODE_MAJOR" -ge 24 ] || die "Node.js >= 24 is required (found $(node --version))."
command -v npx >/dev/null 2>&1 || die "npx is required (it is included with Node.js)."

if ! command -v tmux >/dev/null 2>&1; then
  case "$(uname -s 2>/dev/null || true)" in
    Darwin) die "tmux is required for persistent Sessions. Install it with 'brew install tmux', then rerun this command." ;;
    *) die "tmux is required for persistent Sessions. Install it with your system package manager (Ubuntu/Debian: 'sudo apt-get install tmux'), then rerun this command." ;;
  esac
fi

printf 'RoamCode bootstrap\n  ✓ Node %s\n  ✓ %s\n  → fetching the latest stable installer from npm\n\n' "$(node --version)" "$(tmux -V)"
exec npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install
