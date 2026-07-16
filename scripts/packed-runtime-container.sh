#!/usr/bin/env bash

set -euo pipefail

VERSION="${RC_ACCEPTANCE_VERSION:?RC_ACCEPTANCE_VERSION is required}"
EXPECTED_ARCH="${RC_ACCEPTANCE_EXPECT_ARCH:-}"
ARTIFACTS="${RC_ACCEPTANCE_ARTIFACTS_DIR:-/artifacts}"
PORT="${RC_ACCEPTANCE_PORT:-4398}"
SOCKET="roamcode-packed-acceptance-$$"
RUNTIME="/roamcode-acceptance"
DATA="$RUNTIME/data"
WORKSPACE="$RUNTIME/workspace"
STATE="$RUNTIME/acceptance-state.json"
PROVIDER_STATE="$RUNTIME/fake-provider-state.jsonl"
SERVER_PID=""
SERVER_LOG=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill -TERM "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  tmux -L "$SOCKET" kill-server >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

assert_file() {
  [[ -f "$1" ]] || {
    printf '%s\n' "[packed-container] required artifact is missing" >&2
    exit 1
  }
}

CLI_TARBALL="$ARTIFACTS/roamcode-$VERSION.tgz"
SERVER_TARBALL="$ARTIFACTS/roamcode.ai-server-$VERSION.tgz"
WEB_TARBALL="$ARTIFACTS/roamcode.ai-web-$VERSION.tgz"
POLICY="$ARTIFACTS/package.json"
ACCEPTANCE="$ARTIFACTS/packed-runtime-acceptance.mjs"
FAKE_CLAUDE="$ARTIFACTS/fake-claude.mjs"
FAKE_CODEX="$ARTIFACTS/fake-codex.mjs"

for artifact in "$CLI_TARBALL" "$SERVER_TARBALL" "$WEB_TARBALL" "$POLICY" "$ACCEPTANCE" "$FAKE_CLAUDE" "$FAKE_CODEX"; do
  assert_file "$artifact"
done

if [[ -n "$EXPECTED_ARCH" ]]; then
  [[ "$(node -p 'process.arch')" == "$EXPECTED_ARCH" ]] || {
    printf '%s\n' "[packed-container] unexpected runtime architecture" >&2
    exit 1
  }
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl g++ make python3 tmux >/dev/null
rm -rf /var/lib/apt/lists/*
npm install --global --no-audit --no-fund npm@12.0.1 >/dev/null

mkdir -p "$RUNTIME/install" "$RUNTIME/node" "$RUNTIME/home" "$DATA" "$WORKSPACE"
chmod 700 "$RUNTIME" "$RUNTIME/home" "$DATA"
cp "$POLICY" "$RUNTIME/node/package.json"
npm install --prefix "$RUNTIME/node" --omit=dev --no-audit --no-fund --package-lock=false \
  "$WEB_TARBALL" "$SERVER_TARBALL" "$CLI_TARBALL" >/dev/null

(
  cd "$RUNTIME/node"
  node -e 'const Database=require("better-sqlite3");const db=new Database(":memory:");db.exec("SELECT 1");db.close()'
  node -e 'require("node-pty")'
)

CLI="$RUNTIME/node/node_modules/.bin/roamcode"
[[ "$($CLI --version)" == "$VERSION" ]]
cp "$ACCEPTANCE" "$RUNTIME/packed-runtime-acceptance.mjs"
cp "$FAKE_CLAUDE" "$RUNTIME/fake-claude.mjs"
cp "$FAKE_CODEX" "$RUNTIME/fake-codex.mjs"
chmod 700 "$RUNTIME/packed-runtime-acceptance.mjs" "$RUNTIME/fake-claude.mjs" "$RUNTIME/fake-codex.mjs"
: >"$PROVIDER_STATE"
chmod 600 "$PROVIDER_STATE"
TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
node -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({at:Date.now(),releases:[]})+"\n",{mode:0o600})' \
  "$DATA/release-cache.json"

start_server() {
  local log_path="$1"
  SERVER_LOG="$log_path"
  env \
    ACCESS_TOKEN="$TOKEN" \
    BIND_ADDRESS=127.0.0.1 \
    CLAUDE_BIN="$RUNTIME/fake-claude.mjs" \
    CODEX_BIN="$RUNTIME/fake-codex.mjs" \
    CODEX_HOME="$RUNTIME/codex-home" \
    FS_ROOT="$WORKSPACE" \
    HOME="$RUNTIME/home" \
    PORT="$PORT" \
    RC_FAKE_PROVIDER_STATE="$PROVIDER_STATE" \
    RC_TMUX_SOCKET="$SOCKET" \
    ROAMCODE_DATA_DIR="$DATA" \
    ROAMCODE_INSTALL_ROOT="$RUNTIME/install" \
    ROAMCODE_RATE_LIMIT_RPM=0 \
    WEB_DIR="$RUNTIME/node/node_modules/@roamcode.ai/web/dist" \
    "$CLI" >"$log_path" 2>&1 &
  SERVER_PID=$!
}

wait_for_server() {
  for _ in $(seq 1 80); do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
      return 0
    fi
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      printf '%s\n' "[packed-container] server exited before becoming healthy" >&2
      while IFS= read -r line; do
        printf '[packed-container-log] %s\n' "${line//$TOKEN/[redacted]}" >&2
      done < <(tail -80 "$SERVER_LOG")
      return 1
    fi
    sleep 0.25
  done
  printf '%s\n' "[packed-container] server health timeout" >&2
  while IFS= read -r line; do
    printf '[packed-container-log] %s\n' "${line//$TOKEN/[redacted]}" >&2
  done < <(tail -80 "$SERVER_LOG")
  return 1
}

stop_server() {
  kill -TERM "$SERVER_PID"
  for _ in $(seq 1 40); do
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      wait "$SERVER_PID" >/dev/null 2>&1 || true
      SERVER_PID=""
      return 0
    fi
    sleep 0.25
  done
  printf '%s\n' "[packed-container] server did not stop gracefully" >&2
  return 1
}

run_acceptance() {
  local mode="$1"
  env \
    RC_ACCEPTANCE_BASE_URL="http://127.0.0.1:$PORT" \
    RC_ACCEPTANCE_MASTER_TOKEN="$TOKEN" \
    RC_ACCEPTANCE_MODE="$mode" \
    RC_ACCEPTANCE_PROVIDER_STATE="$PROVIDER_STATE" \
    RC_ACCEPTANCE_STATE="$STATE" \
    RC_ACCEPTANCE_WORKSPACE="$WORKSPACE" \
    node "$RUNTIME/packed-runtime-acceptance.mjs"
}

start_server "$RUNTIME/server-first.log"
wait_for_server
run_acceptance exercise
stop_server
tmux -L "$SOCKET" has-session >/dev/null

start_server "$RUNTIME/server-second.log"
wait_for_server
run_acceptance verify-restart

credential_leaked=false
for diagnostic in "$RUNTIME/server-first.log" "$RUNTIME/server-second.log" "$PROVIDER_STATE"; do
  while IFS= read -r line; do
    if [[ "$line" == *"$TOKEN"* ]]; then
      credential_leaked=true
      break
    fi
  done <"$diagnostic"
done
if [[ "$credential_leaked" == true ]]; then
  printf '%s\n' "[packed-container] a runtime credential reached diagnostic output" >&2
  exit 1
fi

printf '%s\n' "[packed-container] packed install, native modules, restart, and reconnect: complete"
