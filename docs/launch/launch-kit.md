# Launch kit — copy-paste posts

Ready-to-post drafts for the channels where Claude Code, Codex, and self-hosted developer-tool users are. The repo currently gets
essentially **zero external traffic** — so *posting these is the single highest-leverage thing left to do.*
Tweak the voice to yours.

> Before posting: (1) set the **Social preview image** (Settings → General → Social preview → upload
> `docs/social-preview.svg` exported to PNG) so links show the terminal-on-a-phone card, not the generic one;
> (2) have a **20–30s screen recording** of driving one clearly labelled provider from the phone ready — it's the best single asset;
> (3) Be around for the first few hours to answer comments — that's what drives ranking on HN/Reddit/PH.

The one-line thesis to keep hammering: **choose Claude Code or Codex for each session, then drive that
provider's real TUI from your phone. Nothing reinterpreted, nothing lost.**

---

## Show HN (news.ycombinator.com/submit)

**Title** (HN dislikes hype — keep it plain):

```
Show HN: RoamCode – run the real Claude Code or Codex TUI from your phone
```

**URL:** `https://github.com/burakgon/roamcode`

**First comment (post immediately after submitting):**

```
I wanted to kick off and babysit coding-agent sessions from my phone without SSH-ing into tmux from a tiny
keyboard. So I built RoamCode: a self-hosted server + installable PWA that puts the real Claude Code or Codex
terminal on your phone. You explicitly choose the provider for every session; it uses that CLI's login on your host.

The key design decision: don't reinterpret either agent into a chat UI. It's a real terminal (xterm.js) bridged
straight to the selected provider's TUI under tmux, so provider-native permission/sandbox UI, questions, tools,
and agent workflow remain intact.

Two things I'm happy with:
- It survives real life. The session lives in tmux, so a locked phone, a subway tunnel, a killed app, or a
  Wi-Fi→cellular hop just re-attaches where you left off — command still running.
- A full-screen TUI is normally miserable on a touchscreen. The hard part was the ergonomics: a Termux-style
  key bar (Esc/Tab/arrows/Ctrl/^C/^D), a sticky-Ctrl modifier, two-finger scroll to read back, and
  long-press selection with live handles and direct Copy/Paste. Plus files both ways and a git-aware new-session picker.

Architecture: phone (PWA) → your machine (the RoamCode server) → `claude` or `codex` over a PTY. The server
binds to loopback; you put an HTTPS tunnel (cloudflared/Tailscale) in front; every request + the terminal
WebSocket is guarded by a token. Provider-labelled Web Push fires when an agent needs input or finishes.

Honest caveats: it's deliberately remote code execution on your own box (that's the point) and the agent is
NOT sandboxed by RoamCode — either CLI runs as your host user. Provider safety controls help, but the single
shared RoamCode token is the remote-control boundary; treat it like an SSH key. MIT.

Permanent install is one command (verified stable release + per-user service):
  npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install

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
- A Termux-style key bar (Esc, Tab, arrows, Ctrl, ^C, ^D), sticky Ctrl, two-finger scroll, and live long-press selection.
- Files both ways (upload, or ask Claude to send you a file), multiple sessions, git-aware new-session picker.

The control plane runs on your box with no RoamCode cloud relay, secured by a token and your HTTPS tunnel
(cloudflared or Tailscale). Provider traffic follows the CLI's normal service path. Push notifications when it
needs you. In-app one-tap self-update. MIT, brand new.

[screenshots] · one-command install in the README: https://github.com/burakgon/roamcode

Would love feedback from people who live in Claude Code — what would make this your daily driver on mobile?
```

*(Attach 3–4 of the phone screenshots from `docs/media/`. Check r/ClaudeAI self-promo rules; engage in comments.)*

---

## Reddit — r/selfhosted

**Title:** `RoamCode — self-hosted PWA for the real Claude Code or Codex terminal`

**Body:**

```
RoamCode is a self-hosted server + installable PWA that runs the real Claude Code or Codex CLI on your hardware
and puts its terminal on your phone or any browser — the genuine provider TUI over a PTY, not a reinterpretation.

- Host-native: your machine, your files, and each CLI's existing login. RoamCode never collects an API key.
- Sessions live in tmux, so a dropped connection or a closed app just re-attaches — nothing is lost.
- Loopback bind + token auth on every request and the WebSocket; you put your own HTTPS tunnel in front
  (cloudflared named tunnel or `tailscale serve`).
- Installable PWA, Web Push, offline shell. In-app stable-version OTA with integrity verification,
  boot smoke, atomic activation, and rollback.
- Defense-in-depth: cross-origin/CSWSH guard, rate limit, concurrency cap, token rotation. Honest about the
  threat model in the README + SECURITY.md — the agent is not sandboxed; it runs as you.

MIT. One-command install, or clone + build. https://github.com/burakgon/roamcode
```

---

## X / Twitter thread

```
1/ I can now run the REAL Claude Code or Codex TUI from my phone — the actual terminal, not a chat clone.

RoamCode: a self-hosted PWA that asks which provider you want for each session, then puts that CLI's TUI on
your phone. Your machine, your existing CLI login, no RoamCode cloud relay.

[20–30s screen recording]
github.com/burakgon/roamcode 🧵

2/ It's not a bot or a reimplementation. It's a real terminal bridged to the selected provider TUI running on
your box — so native permission/sandbox UI, tools, questions, and agent workflows stay intact.

3/ The part I'm proudest of: it survives real life. The session lives in tmux, so a locked phone, a dead
tunnel, a Wi-Fi→cellular hop — just reconnect and it's exactly where you left it, command still running.

4/ And a full-screen TUI is actually usable by thumb: a Termux-style key bar (Esc/Tab/arrows/Ctrl/^C/^D),
sticky Ctrl, two-finger scroll to read back, and live long-press selection. Plus files both ways + a git-aware picker.

5/ The control plane runs on your box (loopback + token), with your HTTPS tunnel in front. Provider-labelled
push when an agent needs input or finishes. In-app one-tap self-update. Brand new, MIT.

npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install

⭐ + feedback very welcome. What would make it your daily driver?
```

---

## Product Hunt

- **Name:** RoamCode
- **Tagline:** `Run the real Claude Code or Codex TUI from your phone`
- **Topics:** Developer Tools, Artificial Intelligence, Open Source
- **Description:**

```
RoamCode is a self-hosted server + installable PWA that puts the real Claude Code or Codex terminal on your
phone. Pick a provider for every session and get its actual TUI over a PTY, including native safety controls,
tools, and questions. Sessions live in tmux, so a dropped connection or closed app just re-attaches. A
Termux-style key bar, two-finger scroll and live long-press selection make the terminal usable by thumb; files go both
ways. The control plane stays on your host behind loopback, token auth, and your HTTPS tunnel. MIT.
```

- **First comment:** the Show HN first comment, lightly trimmed.

---

## awesome-claude-code (PR to the community list)

One-line entry for the "tooling / UI" section:

```
- [RoamCode](https://github.com/burakgon/roamcode) — Self-hosted server + installable PWA that puts
  the real `claude` CLI's terminal on your phone or any browser (your existing CLI login; tmux-persistent,
  token-secured, HTTPS-tunneled). MIT.
```

*(Also worth: a short dev.to / hashnode write-up of the terminal bridge — xterm.js ↔ tmux ↔ PTY, the
reconnect/persistence model, and making a TUI usable by touch — that's the technically interesting story and
tends to attract the contributor-type audience.)*
