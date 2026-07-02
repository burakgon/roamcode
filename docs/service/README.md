# Running Remote Coder as a service

**Recommended — let the CLI generate the correct unit for your platform:**

```bash
cd <install-dir> && node packages/cli/dist/index.js install
```

It installs a per-user **launchd** (macOS) or **systemd `--user`** (Linux) service with:

- the real entrypoint `<install-dir>/packages/cli/dist/index.js` (not a bare `dist/index.js`),
- a login-shell **`PATH`** — a missing `PATH` is the #1 cause of failed OTA self-updates (the service can't
  find `node`/`pnpm`/`git`/`tmux`), and
- **`Restart=always`** (systemd) — the OTA updater restarts the server by exiting cleanly, so `Restart=on-failure`
  would leave it **down** after a successful update. `always` brings it back.

To remove it: `node packages/cli/dist/index.js uninstall` (prints the exact commands).

> The previously-shipped hand-editable `com.remote-coder.plist` / `remote-coder.service` templates were removed:
> they pointed at the wrong path, omitted `PATH`, and used `Restart=on-failure`. Use `install` above, which
> generates a unit that gets all three right. If you must hand-write one, mirror those three properties.
