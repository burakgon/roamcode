# RoamCode launch kit

This is the public launch package for RoamCode. Keep every post concrete, technical, and easy to verify. Lead with the
real product loop — persistent Sessions and the same live terminal on desktop or mobile — rather than describing it
for five paragraphs.

## Positioning

**Category:** self-hosted mission control for coding agents.

**One sentence:** Run the real Claude Code or Codex TUI on your own machine, keep every Session alive, and use it from
any browser.

**What makes it different:**

- It streams the provider's real terminal UI instead of rebuilding it as a chat transcript.
- Sessions persist in tmux and survive browser, device, and network changes.
- Foreground agent detection adds status without wrapping or replacing the command.
- Desktop split panes, mobile controls, files, and notifications stay attached to the same Session.
- The control plane is standalone. There is no RoamCode account, managed relay, or hosted execution service.

## Assets to prepare

Before publishing:

1. Upload `docs/social-preview.png` as the repository social preview.
2. Record a 20–30 second product clip at 1440×900 or larger: open a long-running Session on desktop, switch to the
   phone, respond to one provider-native prompt, then reopen the same Session on desktop.
3. Use the real screenshots in `docs/media/`; do not add mock device frames, fake logos, or invented usage numbers.
4. Link to `https://roamcode.ai` for installation and `https://github.com/burakgon/roamcode` for source.
5. Answer technical and security questions with direct links to the relevant docs.

## Show HN

**Title**

```text
Show HN: RoamCode – self-hosted mission control for Claude Code and Codex
```

**URL**

```text
https://github.com/burakgon/roamcode
```

**First comment**

```text
I built RoamCode because a coding-agent process should not be coupled to one browser tab or one desk.

It runs an ordinary shell on your machine inside tmux, then exposes the real terminal through an installable browser
app. Start Claude Code, Codex, or another command yourself. Permission prompts, slash commands, diffs, model controls,
sandbox settings, and provider safety behavior stay native.

Sessions hold live persistent terminals, status, files, mobile controls, notifications, and desktop split panes.
RoamCode observes supported foreground agents to add identity and activity without changing the command or its input.

The service is standalone and binds to loopback by default. There is no RoamCode account or hosted relay. For another
device you provide a private or HTTPS path, then issue a five-minute, one-use pairing link. Repositories, provider
credentials, prompts, terminal output, and execution remain on the Node.

Honest boundary: this is remote code execution on your own machine. The agent runs as your host user; RoamCode does not
pretend to be a sandbox. Pairing, device revocation, origin checks, rate limits, integrity-pinned updates, and the full
threat boundary are documented in the repository.

macOS:
  brew install burakgon/roamcode/roamcode && roamcode install

Linux with Node.js 24+ and tmux:
  curl -fsSL https://roamcode.ai/install | bash

MIT. I would especially value feedback on terminal ergonomics and reconnect behavior.
```

## Short community post

```text
RoamCode runs the real Claude Code or Codex TUI on your machine and gives you its full terminal in any browser.

The Session lives in tmux, so closing the PWA or changing networks does not stop the agent. Desktop has persistent
split panes; mobile adds a Termux-style key bar, sticky Ctrl, scrollback, selection, clipboard, files, and direct links
back to a Session that needs input.

There is no hosted RoamCode account or relay. It binds to loopback; you choose a private or HTTPS route and pair each
browser with a short-lived one-use link. MIT, macOS + Linux: https://github.com/burakgon/roamcode
```

## X / Bluesky thread

```text
1/ A coding-agent Session should outlive the browser tab.

RoamCode is self-hosted mission control for the real Claude Code and Codex TUI, with persistent Sessions and
browser/mobile control on your own machine.

2/ This is not another chat wrapper. RoamCode streams the provider's actual terminal UI, so prompts, commands, diffs,
model controls, and safety settings stay native.

3/ Sessions run in tmux. Close the PWA, change networks, or return to your desk — reopen the same process where it is.
Desktop split panes and mobile terminal controls are built into the same app.

4/ Standalone by construction: no RoamCode account, hosted relay, or managed execution. Pair browsers to your Node over
the private or HTTPS route you choose. MIT.
```

## Directory entry

```text
- [RoamCode](https://github.com/burakgon/roamcode) — Self-hosted mission control for the real Claude Code and Codex
  terminal: persistent tmux Sessions and browser/mobile control. MIT.
```

Only submit to maintained lists where RoamCode clearly fits. Follow each repository's contribution format and never
mass-submit identical promotional pull requests.
