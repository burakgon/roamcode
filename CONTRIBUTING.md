# Contributing to RoamCode

Thanks for helping out! RoamCode is a full-TypeScript **pnpm monorepo**:

| Package | What it is |
|---|---|
| `packages/server` | The host daemon: session hub, the tmux + PTY terminal bridge, transport (HTTP/WS), auth, OTA updater. |
| `packages/web` | The installable PWA (React + xterm.js) — the phone/browser client. |
| `packages/cli` | The `roamcode` entry point + the launchd/systemd install command. |

## Dev setup

```bash
corepack enable            # provides the pinned pnpm (or: npm i -g pnpm)
pnpm install               # builds the native better-sqlite3 binding too
pnpm build
```

You'll need **Node ≥ 24**, tmux, and at least one supported provider CLI on this machine: **Claude Code and/or Codex**. Authenticate each CLI using its own supported flow. Codex ChatGPT device-code login can also be initiated from the PWA; never add test code that sends a real prompt or consumes credits.

## The bar for a PR

Everything below must be green — CI runs the same, and `main` must remain ready for the next stable release. A commit
is not an update; users discover only published stable releases.

```bash
pnpm typecheck      # tsc -b across the graph (web typechecked separately)
pnpm lint           # eslint
pnpm format:check   # prettier

# One-time per clone: auto-format staged files on every commit (keeps CI green):
# git config core.hooksPath .githooks
pnpm test           # vitest — server + web
pnpm build          # all packages
```

Guidelines:

- **Tests are not optional.** New behavior needs tests; a bug fix needs a test that would have caught it. Match the existing style — pure functions unit-tested, terminal/PTY paths covered with fake providers on isolated tmux sockets, and no CI test calling a real provider account.
- **Careful with the full suite on a host that's serving a live session.** The real-tmux integration test runs on an isolated socket, but on the machine hosting your own live terminal prefer running targeted test files over the whole suite.
- Keep changes focused and write clear conventional commit subjects (`feat(scope): …`, `fix(scope): …`). Stable OTA
  notes come from the curated release section in `CHANGELOG.md`; commits on `main` are never discoverable updates by
  themselves.

## Reporting bugs / proposing features

Use the **[issue templates](https://github.com/burakgon/roamcode/issues/new/choose)**. For questions, ideas, or to show your setup, use **[Discussions](https://github.com/burakgon/roamcode/discussions)**. For anything security-sensitive, see **[SECURITY.md](SECURITY.md)** — please don't open a public issue.

By contributing you agree your work is licensed under the project's [MIT License](LICENSE).
