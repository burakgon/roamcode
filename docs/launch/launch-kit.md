# Launch kit — copy-paste posts

Ready-to-post drafts for the channels where Claude Code users actually are. The repo currently gets
essentially **zero external traffic** (referrers are ~all internal github.com + a single Instagram share) —
so *posting these is the single highest-leverage thing left to do.* Tweak the voice to yours.

> Before posting: (1) set the **Social preview image** (Settings → General → Social preview → upload
> `docs/social-preview.svg` exported to PNG) so links show a phone screenshot, not the generic card;
> (2) have a **20–30s screen recording** of driving Claude from the phone ready — it's the best single asset.
> (3) Be around for the first few hours to answer comments — that's what drives ranking on HN/Reddit/PH.

---

## Show HN (news.ycombinator.com/submit)

**Title** (HN dislikes hype — keep it plain):

```
Show HN: Remote Coder – run the real Claude Code from your phone (self-hosted PWA)
```

**URL:** `https://github.com/burakgon/remote-coder`

**First comment (post immediately after submitting):**

```
I wanted to kick off and babysit Claude Code sessions from my phone while away from the desk, without
SSH-ing into a tmux from a tiny keyboard. So I built Remote Coder: a self-hosted server + installable PWA
that drives the REAL `claude` CLI on your own machine, using your existing Claude subscription (no API key).

It's not a re-implementation or a bot — it spawns and talks to the actual CLI over its stream-json stdio,
so you get the real thing: streaming output, the permission prompts (you approve each tool from your phone),
AskUserQuestion, subagents shown as live cards, /compact, model switching, and rewind/checkpoint —
including "rewind = edit & resend": tap a past message, it comes back into the composer and the conversation
rolls back to before it.

Architecture: phone (PWA) → your machine (the Remote Coder server) → `claude` CLI. The server binds to
loopback and you put an HTTPS tunnel (cloudflared/Tailscale) in front; every request + the WebSocket is
guarded by a token. Push notifications fire when Claude needs a permission or finishes a turn — and only
when the app isn't already foregrounded.

Honest caveats: it's deliberately remote code execution on your own box (that's the point) and the agent
is NOT sandboxed — `claude` runs as you. A single shared token is the boundary; treat it like an SSH key.
It's brand new and MIT.

Install is one command (clones, builds, starts, prints a connect link):
  curl -fsSL https://raw.githubusercontent.com/burakgon/remote-coder/main/scripts/install.sh | bash

Happy to answer anything about the protocol/transcript handling — the trickiest part was making a reopened
session match the live one exactly (the append-only transcript + checkpoint forks).
```

---

## Reddit — r/ClaudeAI

**Title:** `I built a way to run the real Claude Code from my phone — self-hosted, uses your subscription (no API key)`

**Body:**

```
Made this because I kept wanting to start/answer Claude Code sessions from my phone.

Remote Coder is a self-hosted server + installable PWA that drives the actual `claude` CLI on your own
machine. It's the real CLI — not a bot or a reimplementation — so you get streaming, the permission prompts
(approve each tool from your phone), AskUserQuestion, live subagent cards, /compact, model switch, and
rewind (tap a past message → it drops back into the composer and the chat rolls back to edit & resend).

Runs on your box, your code never leaves it, secured by a token, HTTPS tunnel in front (cloudflared or
Tailscale). Push notifications when it needs you. MIT, brand new.

[screenshots] · one-command install in the README: https://github.com/burakgon/remote-coder

Would love feedback from people who live in Claude Code — what would you want on the phone that the
terminal has and this doesn't yet?
```

*(Attach 3–4 of the phone screenshots from `docs/media/`. Check r/ClaudeAI self-promo rules; engage in comments.)*

---

## Reddit — r/selfhosted

**Title:** `Remote Coder — self-hosted PWA to drive Claude Code on your own machine from your phone`

**Body:**

```
For the Claude Code users here: a self-hosted server + installable PWA that runs the real `claude` CLI on
your own hardware and lets you operate it from your phone or any browser.

- Host-native: your machine, your files, your ~/.claude, your subscription. No API key, no third-party.
- Loopback bind + token auth on every request and the WebSocket; you put your own HTTPS tunnel in front
  (cloudflared named tunnel or `tailscale serve`).
- Installable PWA, Web Push, offline shell. In-app OTA self-update (with a boot-smoke + rollback so a bad
  update can't brick the service).
- Defense-in-depth: cross-origin/CSWSH guard, rate limit, concurrency cap, token rotation. Honest about the
  threat model in the README + SECURITY.md (the agent is not sandboxed — it runs as you).

MIT. One-command install, or clone + build. https://github.com/burakgon/remote-coder
```

---

## X / Twitter thread

```
1/ I can now run the REAL Claude Code from my phone.

Remote Coder: a self-hosted PWA that drives the actual `claude` CLI on your own machine — your subscription,
no API key. Start sessions, approve every tool, rewind & edit — from your pocket.

[20–30s screen recording]
github.com/burakgon/remote-coder 🧵

2/ It's not a bot or a clone. It spawns the real CLI and speaks its stream-json protocol — so you get the
real thing: streaming output, permission prompts, AskUserQuestion, live subagent cards, /compact, model
switching.

3/ The one I'm proudest of: rewind = edit & resend. Tap a past message → it drops back into the composer and
the conversation rolls back to before it. Plus reopen shows exactly the live branch, no rewound-away ghosts.

4/ Runs on your box (loopback + token), HTTPS tunnel in front, your code never leaves. Push notifications
when Claude needs a permission or finishes — and not while you're already looking at it.

5/ Brand new, MIT. One command to try (clones, builds, starts, prints a connect link):

curl -fsSL https://raw.githubusercontent.com/burakgon/remote-coder/main/scripts/install.sh | bash

⭐ + feedback very welcome. What would make it your daily driver?
```

---

## Product Hunt

- **Name:** Remote Coder
- **Tagline:** `Run the real Claude Code from your phone — self-hosted`
- **Topics:** Developer Tools, Artificial Intelligence, Open Source
- **Description:**

```
Remote Coder is a self-hosted server + installable PWA that drives the real Claude Code CLI on your own
machine, using your existing Claude subscription (no API key). Start and babysit sessions from your phone:
streaming output, approve every tool, AskUserQuestion, live subagent cards, /compact, model switching, and
rewind-to-edit-and-resend. Your code never leaves your machine — loopback bind, token auth, your own HTTPS
tunnel, Web Push when it needs you. MIT, one-command install.
```

- **First comment:** the Show HN first comment, lightly trimmed.

---

## awesome-claude-code (PR to the community list)

One-line entry for the "tooling / UI" section:

```
- [Remote Coder](https://github.com/burakgon/remote-coder) — Self-hosted server + installable PWA to run and
  operate the real `claude` CLI from your phone or any browser (your subscription, no API key; token-secured,
  HTTPS-tunneled). MIT.
```

*(Also worth: a short dev.to / hashnode write-up of the protocol/transcript reverse-engineering — that's
the technically interesting story and tends to attract the contributor-type audience.)*
