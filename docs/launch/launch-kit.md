# RoamCode launch kit

This is the public launch package for RoamCode. Keep every post concrete, technical, and easy to verify. Lead with the
real product loop — persistent Sessions, inspectable Automations, and installed Agents — then show the terminal rather
than describing it for five paragraphs.

## Positioning

**Category:** self-hosted mission control for coding agents.

**One sentence:** Run the real Claude Code or Codex TUI on your own machine, keep every Session alive, and control or
automate the work from any browser.

**What makes it different:**

- It streams the provider's real terminal UI instead of rebuilding it as a chat transcript.
- Sessions persist in tmux and survive browser, device, and network changes.
- Automations use manual, schedule, or webhook triggers; every Run becomes a real Session you can inspect.
- Agents is the truthful inventory of installed runtimes on the Node — not a fictional cloud machine model.
- The control plane is standalone. There is no RoamCode account, managed relay, or hosted execution service.

## Assets to prepare

Before publishing:

1. Upload `docs/social-preview.png` as the repository social preview.
2. Record a 20–30 second product clip at 1440×900 or larger:
   - open a long-running Session on desktop;
   - switch to the phone;
   - respond to one provider-native prompt;
   - open the same Session again on desktop;
   - finish on the Automations screen with its resulting Session.
3. Use the real screenshots in `docs/media/`; do not add mock device frames, fake logos, or invented usage numbers.
4. Link to `https://roamcode.ai` for installation and `https://github.com/burakgon/roamcode` for source.
5. Be available after launch to answer technical and security questions with direct links to the relevant docs.

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

It runs the real Claude Code or Codex CLI on your machine inside tmux, then exposes the provider's actual TUI through
an installable browser app. Permission prompts, slash commands, diffs, model controls, sandbox settings, and provider
safety behavior stay native — RoamCode is a terminal control layer, not another chat implementation.

The product has three surfaces:
- Sessions: live persistent terminals, status, files, mobile controls, and desktop split panes.
- Automations: repeatable instructions with manual, schedule, and webhook triggers. Every run creates a Session you can
  open and continue.
- Agents: the installed Claude Code, Codex, or adapter runtimes on this Node, including auth, version, capabilities, and
  active work.

The service is standalone and binds to loopback by default. There is no RoamCode account or hosted relay. For another
device you provide a private or HTTPS path you control, then issue a five-minute, one-use pairing link. Repositories,
provider credentials, prompts, terminal output, and execution remain on the Node. Provider CLIs still use their normal
provider services.

Honest boundary: this is remote code execution on your own machine. The agent runs as your host user; RoamCode does not
pretend to be a sandbox. Pairing, device revocation, origin checks, rate limits, integrity-pinned updates, and the full
threat boundary are documented in the repository.

macOS:
  brew install burakgon/roamcode/roamcode && roamcode install

Linux with Node.js 24+ and tmux:
  curl -fsSL https://roamcode.ai/install | bash

MIT. I would especially value feedback on terminal ergonomics, reconnect behavior, and the Automation model.
```

## Reddit: self-hosted and developer-tool communities

Check each community's current self-promotion rules before posting. Attach one desktop screenshot, one mobile terminal
screenshot, and the short product clip.

**Title**

```text
RoamCode: self-hosted mission control for persistent Claude Code and Codex sessions
```

**Body**

```text
RoamCode runs the real Claude Code or Codex CLI on your machine and gives you its full terminal UI in any browser.

The Session lives in tmux, so closing the PWA or changing networks does not stop the agent. Desktop has persistent split
panes; mobile adds a Termux-style key bar, sticky Ctrl, two-finger scrollback, selection, clipboard, files, and direct
links back to an agent that needs input.

It also has local Automations with manual, schedule, and webhook triggers. A Run is not a hidden background task: it
creates a real Session you can inspect and continue. Agents reports the installed runtimes, auth state, versions, and
capabilities on the Node.

There is no hosted RoamCode account or relay. It binds to loopback; you choose a private or HTTPS route for another
device and pair each browser with a short-lived one-use link. The security model is documented plainly because this is,
by design, remote code execution as your host user.

MIT, macOS + Linux: https://github.com/burakgon/roamcode
```

## X / Bluesky thread

```text
1/ A coding-agent Session should outlive the browser tab.

RoamCode is self-hosted mission control for the real Claude Code and Codex TUI: persistent Sessions, Automations, and
browser/mobile control on your own machine.

[product clip]
https://github.com/burakgon/roamcode

2/ This is not another chat wrapper. RoamCode streams the provider's actual terminal UI, so prompts, commands, diffs,
model controls, and safety settings stay native.

3/ Sessions run in tmux. Close the PWA, change networks, or return to your desk — reopen the same process where it is.
Desktop split panes and mobile terminal controls are built into the same app.

4/ Automations are first-class: manual, schedule, and webhook triggers. Every Run creates a normal Session with history
and a terminal you can inspect or continue.

5/ Standalone by construction: no RoamCode account, hosted relay, or managed execution. Pair browsers to your Node over
the private or HTTPS route you choose. MIT.
```

## Product Hunt

- **Name:** RoamCode
- **Tagline:** Self-hosted mission control for Claude Code and Codex
- **Topics:** Developer Tools, Open Source, Artificial Intelligence
- **Description:**

```text
Run the real Claude Code or Codex TUI on your own machine, keep every Session alive in tmux, and control the work from
any browser. RoamCode combines persistent Sessions, local Automations with schedule and webhook triggers, an honest
inventory of installed Agents, desktop split panes, mobile terminal controls, files, notifications, and secure one-use
device pairing. No hosted RoamCode account or relay. MIT.
```

## Community directories

Use this neutral entry for relevant open-source and coding-agent lists:

```text
- [RoamCode](https://github.com/burakgon/roamcode) — Self-hosted mission control for the real Claude Code and Codex
  terminal: persistent tmux Sessions, local Automations, and browser/mobile control. MIT.
```

Only submit to maintained lists where RoamCode clearly fits. Follow each repository's contribution format and never
mass-submit identical promotional pull requests.
