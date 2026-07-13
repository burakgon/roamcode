# Optional E2E (not in CI)

This component suite (`src/App.test.tsx`) is the default end-to-end coverage: it drives the real
`App` with `fetch` + `WebSocket` stubbed.

A browser-level Playwright E2E is **optional** and MUST run against a MOCK backend — either a tiny
stub server or the real Plan 3 `@roamcode.ai/server` started with the interactive mock
(`packages/server/test/helpers/mock-claude-interactive.mjs`) bound to `127.0.0.1`. It must NEVER hit
the real `claude` binary or any external network, and it is excluded from CI (per the plan's Global
Constraints).

Suggested flow to script later: start the mock server → `pnpm -C packages/web preview` →
`playwright test` that logs in, starts a session via the directory picker, sends a message, answers a
permission, and downloads a file. Wire it as an opt-in `test:e2e` script when added.
