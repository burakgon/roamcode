# Getting started

This guide takes a clean machine from zero to its first persistent RoamCode Session. RoamCode supports macOS and
Linux directly; Windows uses [WSL2](windows-wsl.md).

## What gets installed

`roamcode install` creates a per-user service:

- macOS: a LaunchAgent named `com.roamcode`
- Linux: a `systemd --user` service named `roamcode`

The service listens on `127.0.0.1:4280` by default. Program versions live under `~/.local/share/roamcode`; operational
data lives under `~/.config/roamcode`. Existing pre-rename installations continue to use their compatible legacy data
path when detected.

## 1. Prepare one provider

Install Claude Code, Codex, or another supported adapter on the machine that will run the work. Complete that
provider's normal authentication flow before starting a Session. RoamCode uses the existing CLI login; it does not
collect a provider API key.

You can install both providers and choose one per Session.

## 2. Install RoamCode

### macOS: Homebrew (recommended)

The formula brings Node.js and tmux with it:

```bash
brew install burakgon/roamcode/roamcode
roamcode install
```

### macOS or Linux: published CLI

Requirements:

- Node.js 24 or newer
- tmux
- `npx`, included with Node.js

On Ubuntu or Debian, install tmux with:

```bash
sudo apt-get update && sudo apt-get install -y tmux
```

Then run the small bootstrap:

```bash
curl -fsSL https://roamcode.ai/install | bash
```

The bootstrap only checks prerequisites and delegates the durable installation to the latest stable `roamcode` npm
package. To inspect before executing, open [`scripts/install.sh`](../scripts/install.sh), or run the same published CLI
directly:

```bash
npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install
```

Do not use `sudo` for the RoamCode install. The service and its data belong to your user.

## 3. Pair the first browser

After installation, RoamCode waits for the service health check and prints a QR code plus a five-minute, one-use
pairing link. Open the loopback link in a browser on the same machine.

You can issue a fresh link at any time:

```bash
roamcode pair
```

The browser receives its own revocable device credential. The host recovery credential is never placed in the URL or
browser storage.

## 4. Start the first Session

1. Open **Agents** and confirm your provider says **Ready**.
2. Select the provider and choose **Start session**.
3. Pick a working directory on the Node.
4. Confirm provider-native model and safety settings.
5. Start the Session.

The real provider TUI now runs inside tmux. You can close the browser, reopen RoamCode, and resume the same process.

## 5. Verify the installation

```bash
roamcode status
curl -fsS http://127.0.0.1:4280/health
```

A healthy install reports the service manager and `Server: running at http://127.0.0.1:4280`.

If the provider is not available, check the richer authenticated diagnostics in **Settings**, `/diag`, and
`/providers`. The server can be healthy while an individual provider executable or login is not.

## Connect another device

A `127.0.0.1` link only opens on the Node itself. For a phone or another computer, create a private or HTTPS route you
control, then issue the pairing link for that exact stable origin:

```bash
roamcode pair --url https://your-roamcode.example
```

Continue with the [remote-access guide](remote-access.md). Never expose the plain HTTP port directly to the public
internet.

## Useful commands

```bash
roamcode status       # installed service and loopback reachability
roamcode pair         # new one-use browser pairing link
roamcode --help       # server, API, recovery, and configuration commands
roamcode uninstall    # print safe service-removal commands
```

For environment variables and non-default data paths, see [configuration](configuration.md). For a failed install or
an unreachable service, use [troubleshooting](troubleshooting.md).
