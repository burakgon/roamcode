# Contributing to Remote Coder

Thanks for helping out! Remote Coder is a full-TypeScript **pnpm monorepo**:

| Package | What it is |
|---|---|
| `packages/server` | The host daemon: session hub, the tmux + PTY terminal bridge, transport (HTTP/WS), auth, OTA updater. |
| `packages/web` | The installable PWA (React + xterm.js) — the phone/browser client. |
| `packages/cli` | The `remote-coder` entry point + the launchd/systemd install command. |

## Dev setup

```bash
corepack enable            # provides the pinned pnpm (or: npm i -g pnpm)
pnpm install               # builds the native better-sqlite3 binding too
pnpm build
```

You'll need **Node ≥ 24** and, to actually run a session, **Claude Code installed and logged in** on this machine (`claude` once in a terminal).

## The bar for a PR

Everything below must be green — CI runs the same, and a broken commit can't be allowed onto `main` (the in-app OTA pulls from it):

```bash
pnpm typecheck      # tsc -b across the graph (web typechecked separately)
pnpm lint           # eslint
pnpm format:check   # prettier
pnpm test           # vitest — server + web
pnpm build          # all packages
```

Guidelines:

- **Tests are not optional.** New behavior needs tests; a bug fix needs a test that would have caught it. Match the existing style — pure functions unit-tested, and the terminal/PTY paths covered with fake-pty fixtures (see `packages/server/test`).
- **Careful with the full suite on a host that's serving a live session.** The real-tmux integration test runs on an isolated socket, but on the machine hosting your own live terminal prefer running targeted test files over the whole suite.
- Keep changes focused; write commit subjects in the conventional style (`feat(scope): …`, `fix(scope): …`) — the OTA changelog is generated from them.

## Reporting bugs / proposing features

Use the **[issue templates](https://github.com/burakgon/remote-coder/issues/new/choose)**. For questions, ideas, or to show your setup, use **[Discussions](https://github.com/burakgon/remote-coder/discussions)**. For anything security-sensitive, see **[SECURITY.md](SECURITY.md)** — please don't open a public issue.

By contributing you agree your work is licensed under the project's [MIT License](LICENSE).
