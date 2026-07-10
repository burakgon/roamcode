# roamcode.ai Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the cinematic roamcode.ai landing site (spec: `docs/superpowers/specs/2026-07-10-roamcode-site-design.md`) live on Cloudflare with the custom domain attached.

**Architecture:** Standalone `site/` at repo root, OUTSIDE the pnpm workspace (`packages/*` globs) so self-hosters' OTA builds never touch it. Vanilla Vite+TS; raw WebGL2 glyph hero (no 3D lib); lazy xterm.js playground; one Cloudflare Worker serving static assets + `/api/stars` + `/install`.

**Tech Stack:** Vite 6, TypeScript, @xterm/xterm, lenis, wrangler 4 (devDep). Fonts: Martian Mono (vendored woff2). No framework, no test runner (spec: verification = typecheck + build + live observation; vitest is BANNED on this machine).

## Global Constraints

- Palette: ink `#0a0a0b`, void `#000`, coral `#f77a44` (only page accent), line `#232329`, fg `#e9e9ec`, dim `#93939c`. Green `#7ce38b`/amber `#e8b45a` ONLY inside product replicas.
- Copy: engineer voice; H1 `Leave the desk. Not the session.`; install cmd `curl -fsSL https://roamcode.ai/install | bash`; section eyebrows as shell comments.
- Budgets: initial JS < 120KB gz (xterm lazy-loaded); all assets same-origin; reduced-motion → static composition.
- The visual/DOM reference is the approved mockup: `scratchpad roamcode-site-mockup.html` (artifact `f303cf7c`) — real site refines it, never regresses below it.
- Verification per task: `pnpm typecheck && pnpm build` inside `site/` (single pass, no watch), plus the task's observation step. Commit after each task.

---

### Task 1: Scaffold `site/`

**Files:** Create `site/package.json`, `site/tsconfig.json`, `site/vite.config.ts`, `site/index.html` (skeleton), `site/src/main.ts`, `site/src/styles.css`, `site/.gitignore`.
**Produces:** `pnpm build` → `site/dist/`; scripts: `dev` (never run here), `build` (`vite build`), `typecheck` (`tsc --noEmit`), `deploy` (`wrangler deploy`).

- [ ] package.json: private, type module; deps `@xterm/xterm`, `lenis`; devDeps `vite`, `typescript`, `wrangler`.
- [ ] `pnpm install` (single pass) → `pnpm typecheck && pnpm build` → dist exists.
- [ ] Commit `feat(site): scaffold roamcode.ai site`.

### Task 2: Vendor Martian Mono + tokens + full static page (HTML/CSS, final copy)

**Files:** Create `site/src/fonts/martian-mono-{500,800}.woff2`, modify `index.html`, `styles.css`.
**Produces:** the COMPLETE static page per mockup+spec — topbar, hero (static frame for now), beat, playground shell, 3 feature scenes, trust grid, install, footer. Class names from the mockup are the contract (`.hero`, `#glyphs`, `#cast`, `.scene`, `.rail`, …).

- [ ] Download woff2 from fontsource (`curl -fsSLo … https://cdn.jsdelivr.net/fontsource/fonts/martian-mono@latest/latin-{500,800}-normal.woff2`); `@font-face` with `font-display: swap`; display roles only (headlines/wordmark/eyebrows); terminal replicas stay system mono.
- [ ] Port mockup DOM & CSS, upgraded: real content, AA contrast, focus states, `text-wrap: balance`, mobile breakpoints.
- [ ] Verify: build; open `dist/index.html` head via curl-less check (`ls dist/assets`, grep built css for `martian`); screenshot in verification pass of Task 8.
- [ ] Commit `feat(site): static page — tokens, type, all sections`.

### Task 3: WebGL2 glyph hero (`site/src/glyph-hero.ts`)

**Interfaces:** `initGlyphHero(canvas: HTMLCanvasElement): { setScroll(p: number): void; destroy(): void } | null` (null → caller keeps static fallback visible). `main.ts` calls it; scroll.ts feeds `setScroll(heroProgress)`.

- [ ] Glyph atlas: draw charset `❯█▛▜⏺✳·│─↓+▁` onto offscreen canvas (coral + grey variants) → texture.
- [ ] Instanced quads (~1800 desktop / ~700 mobile): attributes = start pos (scattered sphere), home pos, delay, size, tint. Vertex shader eases start→home (easeOutCubic on `u_time - delay`), adds idle sin drift + mouse parallax (`u_mouse`), and on `u_scroll>0` blows particles outward (velocity ∝ home−center) with fade.
- [ ] Home positions: sample a 64×24 grid masked to a TUI frame layout (border box + title row + 5 content rows + prompt row) so the converged cloud READS as a terminal.
- [ ] Fallbacks: no WebGL2 / reduced-motion → return null (static CSS frame stays). `destroy()` releases GL.
- [ ] Verify: build; screenshot shows converged frame; scrolling dissolves.
- [ ] Commit `feat(site): WebGL2 glyph-field hero`.

### Task 4: Scroll system (`site/src/scroll.ts`)

**Interfaces:** `initScroll(hooks: { onHeroProgress(p: number): void }): void`.

- [ ] Lenis smooth scroll (skip if reduced-motion); rAF loop computes hero progress (0 at top → 1 when hero scrolled past) → `onHeroProgress`.
- [ ] `.rv` reveals via IntersectionObserver (from mockup) + `.beat` word-by-word reveal (`<span>` per word, staggered transition-delay, class toggled on intersect).
- [ ] Scene depth: per-`.scene` IO ratio drives `--ry` rotation → subtle scroll-linked parallax (hover still flattens).
- [ ] Typed H1 (rAF, respects reduced-motion) lives here too.
- [ ] Commit `feat(site): scroll orchestration — lenis, reveals, scene depth, typed H1`.

### Task 5: Playground (`site/src/playground.ts`, `site/src/cast.ts`)

**Interfaces:** `cast.ts` exports `CAST: Frame[]` where `Frame = { text: string; delayMs: number; className?: never }` (ANSI-colored strings for xterm). `initPlayground(container: HTMLElement): void` — lazy `import("@xterm/xterm")` on first intersection.

- [ ] Replay engine: writes frames with real claude pacing; spinner line cycles `✳ ✻ ✽ ·` in-place (CR rewrite) with `(esc to interrupt · ↓ Nk tokens)` counter ticking.
- [ ] Typeable prompt inside xterm (onData handler): line-buffered echo; Enter → in-character canned reply + install command; Ctrl-C clears line. Key bar buttons inject the same sequences; sticky-ctrl modifies next key.
- [ ] xterm theme matches app: bg `#0a0a0b`, coral cursor, DOM renderer defaults fine.
- [ ] Fallback: xterm import failure → mockup-style DOM replay (reuse `#cast` div path).
- [ ] Commit `feat(site): xterm playground with replay + typeable demo prompt`.

### Task 6: Worker + wrangler (`site/worker/index.ts`, `site/wrangler.jsonc`)

**Interfaces:** `GET /api/stars` → `{ stars: number }` (edge-cached 300s, stale-on-error fallback 1328→last-known via cache); `GET /install` → proxied `scripts/install.sh` from `raw.githubusercontent.com/burakgon/roamcode/main`, `content-type: text/x-shellscript`, cached 300s; else `env.ASSETS.fetch`.

- [ ] wrangler.jsonc: name `roamcode-site`, `assets { directory: "dist", binding: "ASSETS" }`, `routes: [{ pattern: "roamcode.ai", custom_domain: true }]`, `compatibility_date` current.
- [ ] main.ts fetches `/api/stars` → star chip (graceful fallback text `Star on GitHub`).
- [ ] Commit `feat(site): worker — static assets, /api/stars, /install`.

### Task 7: Meta & SEO

**Files:** `site/public/favicon.svg` (coral ❯ on ink, from docs/icon.svg mark), `og.png` 1200×630 (render `site/og.html` via headless chromium if available, else export composed SVG), `robots.txt`, `sitemap.xml`; `<meta>`/OpenGraph/Twitter tags + JSON-LD SoftwareApplication in index.html; Cloudflare Web Analytics beacon snippet (token added post-deploy if needed).

- [ ] Commit `feat(site): favicon, og image, seo meta`.

### Task 8: Deploy + verify live

- [ ] `pnpm build` (final single pass). `pnpm exec wrangler whoami` → if unauthenticated, ask operator to run `! cd site && npx wrangler login`.
- [ ] `pnpm exec wrangler deploy` → workers.dev URL live. Attach custom domain (wrangler config route; verify zone `roamcode.ai` present via `wrangler` output or Cloudflare MCP).
- [ ] Observe: `curl -sI https://roamcode.ai` 200; `curl -s https://roamcode.ai/api/stars`; `curl -sI https://roamcode.ai/install`; screenshot desktop+mobile (playwright if present, else manual link to user).
- [ ] Commit `chore(site): deploy config`, push branch → main.

### Task 9: README cross-link

- [ ] README hero: add `**[roamcode.ai](https://roamcode.ai)**` line + swap install cmd to `curl -fsSL https://roamcode.ai/install | bash` (redirect keeps old raw URL working). Commit + push.

## Self-Review

- Spec coverage: hero(T3), beat/scroll(T4), playground(T5), scenes/trust/install/footer(T2), worker/hosting(T6,T8), meta(T7), README(T9) ✓
- No dangling interfaces: `initGlyphHero`/`setScroll` (T3) consumed in T4 hook; `CAST` (T5) internal ✓
- No test-runner steps anywhere (machine constraint) ✓
