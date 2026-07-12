# RoamCode on Windows (WSL2)

RoamCode's server needs a POSIX host (tmux + PTYs), so on Windows it runs inside **WSL2** —
which works well: the phone talks to a tunnel, the tunnel talks to the server in WSL, and the
selected Claude Code or Codex CLI runs right next to your repos.

> **Status: community-verified wanted.** This guide is written from WSL2's documented behavior
> and the server's actual requirements, but the maintainers develop on macOS/Linux. If you run
> it on a real Windows machine, please report what worked or broke in
> [Discussions](https://github.com/burakgon/roamcode/discussions) — or send a PR for this page.

## Prerequisites

1. **WSL2 with Ubuntu** (Windows 10 21H2+ or Windows 11):
   ```powershell
   wsl --install -d Ubuntu
   ```
2. Inside Ubuntu — the same requirements as Linux:
   ```bash
   sudo apt update
   sudo apt install -y tmux git build-essential python3   # build tools: node-pty compiles a native module
   # Node >= 24 (via nvm, n, or NodeSource — whatever you prefer)
   ```
3. At least one supported CLI installed *inside WSL* (the Windows-side installation does not count):
   ```bash
   # Claude Code: install by your preferred supported method, then authenticate `claude`
   # Codex: install by your preferred supported method, then authenticate `codex`
   ```

   You may install both and choose per session. Codex ChatGPT device-code login can also be initiated from the
   RoamCode PWA after the server is reachable; RoamCode does not collect API keys.

## Install RoamCode

Same one-liner, inside the Ubuntu shell:

```bash
curl -fsSL https://roamcode.ai/install | bash
```

It clones to `~/roamcode`, builds, and starts a foreground trial that prints your connect link.

- **From the Windows browser:** `http://localhost:4280` works out of the box — WSL2 forwards
  localhost automatically.
- **From your phone:** run a tunnel *inside WSL* exactly like on Linux (cloudflared or
  Tailscale; see the README's ["From your phone"](../README.md#from-your-phone)).

## Running it as a service

`roamcode install` writes a **systemd user unit** — WSL2 supports systemd, but it may be off:

```bash
# /etc/wsl.conf (inside Ubuntu; create if missing)
[boot]
systemd=true
```

Then from PowerShell: `wsl --shutdown`, reopen Ubuntu, and:

```bash
cd ~/roamcode && node packages/cli/dist/index.js install
systemctl --user enable --now roamcode
```

Two WSL-specific caveats:

- **WSL stops when no shell is open** (by default). For an always-on server either keep a
  terminal open, or enable Windows' *"keep WSL running"* behaviors (`wsl --manage --set-sparse`,
  a scheduled task running `wsl -d Ubuntu -e true` at logon, or a tray tool). A machine that
  sleeps takes the server down regardless — same as macOS/Linux laptops.
- `systemctl --user` sessions require *lingering* to survive the last shell closing:
  `sudo loginctl enable-linger $USER`.

## Known sharp edges

| Symptom | Cause / fix |
| --- | --- |
| `node-pty` fails to build | Missing `build-essential`/`python3` — install and re-run the installer. |
| Sessions fail with a tmux error | `tmux` not installed in the distro (the Windows side doesn't count). |
| One provider is unavailable | Install/authenticate that CLI inside WSL, or set `CLAUDE_BIN` / `CODEX_BIN` to its WSL path. The other provider remains usable. |
| Phone can't reach the server | The tunnel must run **inside WSL**; Windows firewalls don't apply to it. |
| Everything dies when you close the terminal | See the service section above — enable systemd + lingering. |
