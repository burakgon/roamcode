# roamcode.ai — marketing site design

Date: 2026-07-10 · Status: approved (mockup approved by owner; "animasyonları daha bile uçur")
Mockup: claude.ai artifact `f303cf7c` (first-mockup)

## Goal

A cinematic, product-true landing site at **roamcode.ai** that makes an engineer stop scrolling,
try the playground, and star/install RoamCode. Success metric: it materially drives the
100k-star ambition — people share it because the site itself is craft.

**Non-goals (v1):** docs pages, blog, pricing, i18n (English only), CMS, SSR.

## Voice & visual constitution (anti-slop rules)

- Engineer voice: dry, specific, zero marketing foam. Section labels are shell comments (`# trust`).
- One world: the terminal. Near-black `#0a0a0b`/`#000`, one accent — the product's coral `#f77a44`.
  Semantic green/amber only inside product replicas (session states), never as page decoration.
- Every pixel is product: hand-built HTML TUI replicas and real interaction patterns — no stock
  art, no generic 3D objects, no screenshots-in-browserframes stock template.
- Typography: display = **Martian Mono** (variable, self-hosted woff2, subset) — brutalist-terminal
  character for headlines/wordmark; terminal/body text = system mono stack (authentic, 0 bytes).
- All requests same-origin (fonts self-hosted). Cloudflare Web Analytics beacon is the only exception.

## Page narrative (single page, deep scroll)

1. **Hero — "The Assembly"**: WebGL2 glyph field (raw shader, no 3D lib). Thousands of terminal
   glyphs drift in space → converge into a recognizable claude TUI frame; typed H1
   *"Leave the desk. Not the session."*; sub-line; copyable install command
   (`curl -fsSL https://roamcode.ai/install | bash`); live GitHub star chip; scroll cue.
   Scrolling away **dissolves** the field (particles blow off with velocity + fade).
   Mouse/gyro parallax. Reduced-motion/no-WebGL: static composed frame.
2. **Beat**: interstitial line, revealed word-by-word on scroll: "You started a 40-minute
   refactor. / Now you have to leave. / Your agent shouldn't notice."
3. **Playground**: real **xterm.js** (lazy-loaded) replaying a hand-authored claude session
   (timed frames incl. cycling spinner glyphs ✳✻✽·, tool calls, diff stats, tests). Prompt is
   typeable; Enter → canned in-character reply pointing at the install command. Mobile key bar
   below (esc/tab/arrows/sticky-ctrl/^C/paste) with working sticky-ctrl toy. Caption is honest:
   "Replay, not a sandbox."
4. **Feature scenes** (scroll-driven CSS-3D, device frames rotate slightly with scroll progress,
   staggered reveals): `# ergonomics` phone + key bar → `# splits` desktop panes →
   `# presence` sessions rail + push toast. All replicas hand-built HTML.
5. **`# trust`**: 4-cell grid — your subscription (no API bill), token auth + origin guard +
   rate limit, zero telemetry (only network call is your own git remote on OTA), MIT + small
   readable codebase.
6. **`# install`**: big copyable command, requirements line (macOS/Linux · Node ≥ 24 · tmux ·
   claude CLI), link to README for the manual path.
7. **Footer**: wordmark line, GitHub / Discussions / Security / MIT.

## Architecture

```
site/                      ← repo root, OUTSIDE pnpm workspace (globs = packages/*),
  package.json             so OTA `pnpm -r build` on user machines never builds the site
  vite.config.ts
  wrangler.jsonc           ← Worker w/ static assets + custom_domain roamcode.ai
  worker/index.ts          ← GET /api/stars (GitHub stars, 5-min cache)
                             GET /install   (proxies raw install.sh, 5-min cache, text/x-shellscript)
                             everything else → static assets
  src/                     ← vanilla TS, no framework
    main.ts styles.css glyph-hero.ts (raw WebGL2) playground.ts (xterm) scroll.ts (reveals+scenes)
    cast.ts (replay script) fonts/ (Martian Mono woff2 subset)
  public/ (favicon.svg og.png robots.txt sitemap.xml)
```

- **No 3D library**: hero is ~300-line WebGL2 (instanced quads + canvas-rendered glyph atlas).
- **Scroll**: IntersectionObserver + one rAF timeline; Lenis (~7KB) for smooth scroll, disabled
  under reduced-motion.
- **Budgets**: initial JS < 120KB gz (xterm lazy); LCP < 1.5s; Lighthouse ≥ 95 across the board.
- **A11y**: canvas `aria-hidden`, playground input labeled, visible focus, reduced-motion = full
  static composition, contrast AA.

## Hosting & deploy

- Cloudflare **Workers static assets** via `wrangler deploy` from `site/` (wrangler as devDep).
- Custom domain **roamcode.ai** (zone already in the account) via wrangler `routes[custom_domain]`.
- Verification: fetch live URL, check /api/stars + /install, Lighthouse spot-check.
- Phase 2 (not this pass): Workers Builds git-connect for push-to-deploy; `www` redirect.

## Constraints from this machine (prod Mac)

- NO vitest runs here (absolute rule — drops the user's live session). Site has no test suite in
  v1; verification = build + typecheck + live fetch + screenshots.
- Single `pnpm install` (site/ only) + single `vite build` per iteration; no watch modes.

## Risks

- wrangler auth may need a one-time `wrangler login` from the operator.
- GitHub unauthenticated rate limit for /api/stars → mitigated by 5-min edge cache + stale-on-error.
- Font subset must cover glyphs used in display copy only (terminal replicas use system mono).
