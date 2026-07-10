# Launch kit — copy-paste posts

Ready-to-post drafts for the channels where Claude Code users actually are. The repo currently gets
essentially **zero external traffic** — so *posting these is the single highest-leverage thing left to do.*
Tweak the voice to yours.

> Before posting: (1) set the **Social preview image** (Settings → General → Social preview → upload
> `docs/social-preview.svg` exported to PNG) so links show the terminal-on-a-phone card, not the generic one;
> (2) have a **20–30s screen recording** of driving Claude from the phone ready — it's the best single asset;
> (3) Be around for the first few hours to answer comments — that's what drives ranking on HN/Reddit/PH.

The one-line thesis to keep hammering: **it's not a chat that reinterprets Claude Code — it's the real
`claude` TUI, in a terminal, on your phone. Nothing reinterpreted, nothing lost.**

---

## Show HN (news.ycombinator.com/submit)

**Title** (HN dislikes hype — keep it plain):

```
Show HN: RoamCode – run the real Claude Code TUI from your phone (self-hosted PWA)
```

**URL:** `https://github.com/burakgon/roamcode`

**First comment (post immediately after submitting):**

```
I wanted to kick off and babysit Claude Code sessions from my phone without SSH-ing into a tmux from a
tiny keyboard. So I built RoamCode: a self-hosted server + installable PWA that puts the REAL `claude`
CLI's terminal on your phone — your own machine, your existing Claude subscription, no API key.

The key design decision: don't reinterpret Claude Code into a chat UI (which is what the bots do, so they
drift and can't answer its prompts). Instead it's a real terminal (xterm.js) bridged straight to the actual
`claude` TUI running under tmux on your box. So you get the genuine thing — permission prompts, questions,
subagents, /compact, model switching, thinking — because it IS the CLI, not a copy trying to keep up with it.

Two things I'm happy with:
- It survives real life. The session lives in tmux, so a locked phone, a subway tunnel, a killed app, or a
  Wi-Fi→cellular hop just re-attaches where you left off — command still running.
- A full-screen TUI is normally miserable on a touchscreen. The hard part was the ergonomics: a Termux-style
  key bar (Esc/Tab/arrows/Ctrl/^C/^D), a sticky-Ctrl modifier, two-finger scroll to read back, and
  tap-to-select copy. Plus files both ways and a git-aware new-session picker.

Architecture: phone (PWA) → your machine (the RoamCode server) → `claude` CLI over a PTY. The server
binds to loopback; you put an HTTPS tunnel (cloudflared/Tailscale) in front; every request + the terminal
WebSocket is guarded by a token. Web Push fires when Claude needs a permission or finishes a turn.

Honest caveats: it's deliberately remote code execution on your own box (that's the point) and the agent is
NOT sandboxed — `claude` runs as you. A single shared token is the boundary; treat it like an SSH key. MIT.

Install is one command (clones, builds, starts, prints a connect link):
  curl -fsSL https://raw.githubusercontent.com/burakgon/roamcode/main/scripts/install.sh | bash

Happy to answer anything about the terminal bridge or the tmux persistence — making a TUI genuinely usable
by thumb and reconnect-proof was the fun part.
```

---

## Reddit — r/ClaudeAI

**Title:** `I built a way to run the real Claude Code TUI from my phone — self-hosted, uses your subscription (no API key)`

**Body:**

```
Made this because I kept wanting to start and babysit Claude Code sessions from my phone.

RoamCode is a self-hosted server + installable PWA that puts the actual `claude` CLI's terminal on your
phone. It's not a bot or a reimplementation — it's a real terminal wired straight to the `claude` TUI running
on your own machine. So everything Claude Code does works exactly as it does at your desk: the permission
prompts (you approve each tool), AskUserQuestion, live subagents, /compact, model switching, thinking.

The bits that make a phone terminal actually usable:
- tmux persistence — lock the phone / lose signal / close the app, reconnect and it's right where you left it.
- A Termux-style key bar (Esc, Tab, arrows, Ctrl, ^C, ^D), sticky Ctrl, two-finger scroll, tap-to-select copy.
- Files both ways (upload, or ask Claude to send you a file), multiple sessions, git-aware new-session picker.

Runs on your box, your code never leaves it, secured by a token, HTTPS tunnel in front (cloudflared or
Tailscale). Push notifications when it needs you. In-app one-tap self-update. MIT, brand new.

[screenshots] · one-command install in the README: https://github.com/burakgon/roamcode

Would love feedback from people who live in Claude Code — what would make this your daily driver on mobile?
```

*(Attach 3–4 of the phone screenshots from `docs/media/`. Check r/ClaudeAI self-promo rules; engage in comments.)*

---

## Reddit — r/selfhosted

**Title:** `RoamCode — self-hosted PWA to drive Claude Code's terminal on your own machine from your phone`

**Body:**

```
For the Claude Code users here: a self-hosted server + installable PWA that runs the real `claude` CLI on
your own hardware and puts its terminal on your phone or any browser — the genuine TUI, bridged over a PTY,
not a reinterpretation.

- Host-native: your machine, your files, your ~/.claude, your subscription. No API key, no third-party.
- Sessions live in tmux, so a dropped connection or a closed app just re-attaches — nothing is lost.
- Loopback bind + token auth on every request and the WebSocket; you put your own HTTPS tunnel in front
  (cloudflared named tunnel or `tailscale serve`).
- Installable PWA, Web Push, offline shell. In-app OTA self-update (a failed build leaves the running
  server untouched).
- Defense-in-depth: cross-origin/CSWSH guard, rate limit, concurrency cap, token rotation. Honest about the
  threat model in the README + SECURITY.md — the agent is not sandboxed; it runs as you.

MIT. One-command install, or clone + build. https://github.com/burakgon/roamcode
```

---

## X / Twitter thread

```
1/ I can now run the REAL Claude Code from my phone — the actual terminal, not a chat clone.

RoamCode: a self-hosted PWA that puts the `claude` CLI's TUI on your phone. Your machine, your
subscription, no API key.

[20–30s screen recording]
github.com/burakgon/roamcode 🧵

2/ It's not a bot or a reimplementation. It's a real terminal bridged to the actual `claude` TUI running on
your box — so you get the real thing: permission prompts, AskUserQuestion, live subagents, /compact, model
switching. Nothing reinterpreted, nothing lost.

3/ The part I'm proudest of: it survives real life. The session lives in tmux, so a locked phone, a dead
tunnel, a Wi-Fi→cellular hop — just reconnect and it's exactly where you left it, command still running.

4/ And a full-screen TUI is actually usable by thumb: a Termux-style key bar (Esc/Tab/arrows/Ctrl/^C/^D),
sticky Ctrl, two-finger scroll to read back, tap-to-select copy. Plus files both ways + a git-aware picker.

5/ Runs on your box (loopback + token), HTTPS tunnel in front, your code never leaves. Push when Claude needs
a permission or finishes. In-app one-tap self-update. Brand new, MIT.

curl -fsSL https://raw.githubusercontent.com/burakgon/roamcode/main/scripts/install.sh | bash

⭐ + feedback very welcome. What would make it your daily driver?
```

---

## Product Hunt

- **Name:** RoamCode
- **Tagline:** `Run the real Claude Code TUI from your phone — self-hosted`
- **Topics:** Developer Tools, Artificial Intelligence, Open Source
- **Description:**

```
RoamCode is a self-hosted server + installable PWA that puts the real Claude Code CLI's terminal on your
phone, using your existing Claude subscription (no API key). It's the actual `claude` TUI bridged over a PTY
— not a chat that reinterprets it — so you get everything: permission prompts, AskUserQuestion, live
subagents, /compact, model switching. Sessions live in tmux, so a dropped connection or a closed app just
re-attaches. A Termux-style key bar, two-finger scroll and tap-to-select copy make the terminal usable by
thumb; files go both ways. Your code never leaves your machine — loopback bind, token auth, your own HTTPS
tunnel, Web Push when it needs you. MIT, one-command install.
```

- **First comment:** the Show HN first comment, lightly trimmed.

---

## awesome-claude-code (PR to the community list)

One-line entry for the "tooling / UI" section:

```
- [RoamCode](https://github.com/burakgon/roamcode) — Self-hosted server + installable PWA that puts
  the real `claude` CLI's terminal on your phone or any browser (your subscription, no API key; tmux-persistent,
  token-secured, HTTPS-tunneled). MIT.
```

*(Also worth: a short dev.to / hashnode write-up of the terminal bridge — xterm.js ↔ tmux ↔ PTY, the
reconnect/persistence model, and making a TUI usable by touch — that's the technically interesting story and
tends to attract the contributor-type audience.)*
