#!/usr/bin/env bash
# RoamCode — one-command installer.
#   curl -fsSL https://raw.githubusercontent.com/burakgon/roamcode/main/scripts/install.sh | bash
#
# Clones (or updates) the repo into ~/roamcode, installs + builds, and starts the server, which prints
# a one-time connect link (URL + token) to open on your phone. Re-runnable. No sudo, user-space only.
#
# Env overrides: ROAMCODE_DIR (install dir), PORT (default 4280), RC_NO_START=1 (set up but don't run).
set -euo pipefail

REPO="https://github.com/burakgon/roamcode.git"
# Pre-rename installs live in ~/remote-coder (or wherever REMOTE_CODER_DIR pointed) — keep updating THAT
# checkout instead of cloning a duplicate that would fight over the port.
DIR="${ROAMCODE_DIR:-${REMOTE_CODER_DIR:-$HOME/roamcode}}"
if [ ! -d "$DIR" ] && [ -z "${ROAMCODE_DIR:-}" ] && [ -z "${REMOTE_CODER_DIR:-}" ] && [ -d "$HOME/remote-coder" ]; then
  DIR="$HOME/remote-coder"
fi
PORT="${PORT:-4280}"

c() { printf '\033[%sm' "$1"; }
say() { printf '%s▶%s %s\n' "$(c '1;38;5;209')" "$(c 0)" "$1"; }
ok() { printf '%s✓%s %s\n' "$(c '1;32')" "$(c 0)" "$1"; }
warn() { printf '%s!%s %s\n' "$(c '1;33')" "$(c 0)" "$1" >&2; }
die() {
  printf '%s✗%s %s\n' "$(c '1;31')" "$(c 0)" "$1" >&2
  exit 1
}

say "RoamCode installer"

# 1. Preflight — fail early with an actionable message (no half-installs).
command -v git >/dev/null 2>&1 || die "git not found. Install git, then re-run."
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node >= 24 (https://nodejs.org), then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 24 ] || die "Node >= 24 required (found $(node -v 2>/dev/null)). Upgrade Node, then re-run."

# pnpm via corepack (ships with Node) so the install matches the repo's pinned packageManager.
if ! command -v pnpm >/dev/null 2>&1; then
  say "Enabling pnpm via corepack…"
  corepack enable >/dev/null 2>&1 || true
fi
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then
  PNPM="corepack pnpm"
else
  die "pnpm not found and corepack is unavailable. Install pnpm (https://pnpm.io), then re-run."
fi

# Provider CLIs — probe independently and warn (never fatal). The server still starts for diagnostics, and
# either installed provider remains usable when the other is absent.
HAS_CLAUDE=0
HAS_CODEX=0
if command -v claude >/dev/null 2>&1; then
  HAS_CLAUDE=1
  ok "Found claude $(claude --version 2>/dev/null | head -1)"
else
  warn "The 'claude' CLI was not found on PATH. Claude Code sessions will be unavailable."
  warn "Install Claude Code to enable them. (https://docs.claude.com/claude-code)"
fi
if command -v codex >/dev/null 2>&1; then
  HAS_CODEX=1
  ok "Found codex $(codex --version 2>/dev/null | head -1)"
else
  warn "The 'codex' CLI was not found on PATH. Codex sessions will be unavailable."
  warn "Install Codex to enable them. (https://developers.openai.com/codex/cli)"
fi
if [ "$HAS_CLAUDE" -eq 0 ] && [ "$HAS_CODEX" -eq 0 ]; then
  warn "At least one supported coding agent (Claude Code or Codex) is required to start a session."
fi

# tmux is REQUIRED for terminal sessions (the only session mode). Without it the app boots but every session
# fails — warn loudly rather than let it fail mysteriously later.
if command -v tmux >/dev/null 2>&1; then
  ok "Found $(tmux -V 2>/dev/null)"
else
  warn "'tmux' was not found on PATH — it's REQUIRED for terminal sessions. Install it (macOS: 'brew install"
  warn "tmux'; Debian/Ubuntu: 'sudo apt install tmux'), then re-run, or sessions won't start."
fi

# 2. Clone or update.
if [ -d "$DIR/.git" ]; then
  say "Updating existing checkout at $DIR…"
  git -C "$DIR" pull --ff-only || warn "Could not fast-forward $DIR — leaving it as-is."
else
  say "Cloning into $DIR…"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

# 3. Install + build (the native better-sqlite3 binding is best-effort; the server warns + degrades if it
#    can't load).
say "Installing dependencies…"
$PNPM install --frozen-lockfile
$PNPM approve-builds better-sqlite3 esbuild >/dev/null 2>&1 || true
$PNPM rebuild better-sqlite3 >/dev/null 2>&1 || true
say "Building…"
$PNPM -r build
ok "Built."

if [ "${RC_NO_START:-}" = "1" ]; then
  ok "Setup complete. Start it any time with:  cd $DIR && node packages/cli/dist/index.js"
  exit 0
fi

# 4. Run — the CLI prints the one-time connect link (URL + token). Open it on your phone (same network),
#    or expose it with a tunnel (see the README's "From your phone").
# NOTE: this is a FOREGROUND trial — it stops when you close this terminal. To run it as an always-on
# service (survives logout/reboot), install the service unit instead of this foreground start:
say "This is a FOREGROUND trial (stops when this terminal closes). For an always-on service, run:"
say "    cd $DIR && node packages/cli/dist/index.js install   # prints the enable + tunnel steps"
echo
say "Starting RoamCode on http://127.0.0.1:$PORT"
say "It will print a connect link with your token below. Open it on your phone, or tunnel it (see README)."
echo
exec node packages/cli/dist/index.js
