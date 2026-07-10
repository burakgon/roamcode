# roamcode — Plan 4: PWA (Installable Web App) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@roamcode/web` — an installable, mobile-first + desktop React/Vite PWA that operates remote `claude` sessions through the Plan 3 server: login + token storage, session list, a first-class directory picker + new-session wizard, a live streaming chat view with inline permission (allow/deny) answering, image/file upload + download, per-session settings (effort/model/permission/dangerously-skip), and a service-worker PWA layer — all built against the documented REST/WS API, with Vitest + @testing-library/react component tests and a mock-server E2E.

**Architecture:** A new pnpm workspace package `packages/web` (Vite + React + TypeScript, Zustand state). A thin `api` REST client and a reconnecting `ws` client (token auth, `?since=<seq>` delta replay) feed a Zustand store that maps the server's `ServerFrame { seq, kind, payload }` stream into per-session UI state (assistant text, `stream_event` token deltas, tool-use activity, results, the pending permission). The UI is a calm, telemetry-forward "mission control" dark theme (design tokens baked in) whose ONE alive element is a per-session "live wire" activity indicator. Task 1 ships the design system + a static screenshotted mockup for sign-off **before** the rest is built. The client talks ONLY to the Plan 3 server; tests never reach the real `claude` or the network.

**Tech Stack:** React 18 + Vite 5 + TypeScript 5 (ESM, `verbatimModuleSyntax`), Zustand 5 (state), `vite-plugin-pwa` (manifest + service worker + install), `@fontsource` self-hosted fonts (Space Grotesk / Inter / JetBrains Mono), `react-markdown` + `shiki` (markdown + syntax highlight), Vitest + `@testing-library/react` + `jsdom` (unit/component), Playwright (optional E2E against a mock server). Runtime Node v25.9.0, pnpm 11.8.0.

## Global Constraints

- TypeScript + ESM (`"type":"module"`), pnpm workspace `packages/web`. `tsconfig.base.json` sets `composite`, `strict`, `noUncheckedIndexedAccess`, and **`verbatimModuleSyntax: true`** → every type-only import MUST use `import type { ... }`. The web package's `tsconfig.json` additionally needs `"jsx": "react-jsx"`, `"lib": ["ES2022","DOM","DOM.Iterable"]`, `"types": ["vite/client"]`, and (for tests) the Vitest globals — set up in Task 1.
- **No `@anthropic-ai/*` dependency; no `ANTHROPIC_API_KEY`** anywhere in the web package. The client never speaks to Anthropic directly — only to the Plan 3 `@roamcode/server` REST/WS API. MIT; English.
- **The client conforms EXACTLY to the Plan 3 server contract** (verified against `packages/server/src/transport.ts` + `session-hub.ts` + `replay-buffer.ts` + `fs-service.ts`):
  - **Auth:** REST requires `Authorization: Bearer <token>` OR `?token=<token>`. WS auth is `?token=<token>` on the upgrade URL (browsers cannot set WS headers). A loopback server with **no** token configured accepts unauthenticated requests (dev) — the client must work with or without a token. A bad token → REST `401 { error:"unauthorized" }`; WS upgrade fails (the browser `WebSocket` fires `error` then `close`, code `1006`, never `open`).
  - **REST routes:** `POST /sessions` body `{ cwd:string; model?:string; effort?:string; addDirs?:string[]; dangerouslySkip?:boolean }` → `201 { session: SessionMeta }` (`400` if `cwd` missing). `GET /sessions` → `200 { sessions: SessionMeta[] }`. `GET /sessions/:id` → `200 { session: SessionMeta; history: ServerFrame[] }` | `404`. `POST /sessions/:id/stop` → `200 { ok:true }` | `404`. `GET /fs/list?path=<dir>` → `200 DirListing` (path defaults to the server's `fsRoot` when omitted) | `400` on traversal. `GET /fs/download?path=<file>` → `200` bytes + `Content-Disposition` | `400` traversal | `404` missing. `POST /fs/upload?dir=<dir>` multipart, single field **`file`** → `201 { path:string }` | `400` | `413` (over the server's size cap).
  - **WS route** `GET /sessions/:id/ws?token=<t>` with optional `&since=<seq>` (replay only frames with `seq > since`; omit for a full replay). **Server→client:** JSON-stringified `ServerFrame = { seq:number; kind:"event"|"permission"|"result"|"diagnostic"|"exit"; payload:unknown }`. On (re)connect the buffered frames are replayed first, then live frames. **Client→server** (JSON): `{ type:"user", content:string }` OR `{ type:"user", blocks: ContentBlock[] }` OR `{ type:"user", text?:string, images?:{ mediaType:string; dataBase64:string }[] }`; and `{ type:"permission", requestId:string, decision:"allow"|"deny", reason?:string }`. Unknown frame types are ignored server-side; an unknown session closes the socket with code `4404`.
  - **Payload types by `kind`** (the client renders these): `kind:"event"` → an `InboundEvent` (one of `SystemEvent` / `StreamEvent` / `AssistantEvent` / `UserEvent` / `ResultEvent` / `ControlRequestEvent` / `ControlResponseEvent` / `RateLimitEvent` / `UnknownEvent`); `kind:"permission"` → `PermissionEvent { requestId:string; kind:"hook_callback"|"can_use_tool"; toolName?:string; toolInput?:unknown; toolUseId?:string }`; `kind:"result"` → `ResultEvent { type:"result"; subtype?; isError?; result?; sessionId?; totalCostUsd?; permissionDenials?; raw }`; `kind:"diagnostic"` → `{ source:"stderr"|"parser"; message:string }`; `kind:"exit"` → process exit info (treat as an opaque object). `SessionMeta = { id; cwd; model?; effort?; dangerouslySkip:boolean; status:"running"|"errored"|"stopped"; createdAt:number }`. `DirEntry = { name; path; isDirectory; isGitRepo; gitBranch? }`; `DirListing = { path; parent?; entries: DirEntry[] }`. `ContentBlock = { type:"text"; text:string } | { type:"image"; source:{ type:"base64"; media_type:string; data:string } }`.
  - **Streaming render shapes** (from `docs/protocol-notes.md`): assistant text arrives both as `StreamEvent` token deltas (`payload.event.type === "content_block_delta"` with `delta.type === "text_delta"` → `delta.text`; `thinking_delta` → `delta.thinking`; `input_json_delta` → streamed tool input) AND as a final `AssistantEvent` (`payload.message.content[]` blocks: `text` / `tool_use {id,name,input}`). Tool results arrive as `UserEvent` (`payload.message.content[]` `tool_result {tool_use_id, content}`). The client coalesces deltas into the live turn and reconciles against the final `AssistantEvent`.
- **Image limits (vision):** PNG/JPEG/GIF/WebP, ≤5 MB each, ≤8000×8000 — the composer rejects oversized/unsupported images client-side with a clear message (spec §3). General file uploads are capped server-side (`413`); surface that error.
- **Security caveat to document in-app and in code comments:** the access token is stored in `localStorage` (client-side only) — this is XSS-exposed by design for a single-user self-hosted tool; note it, do not pretend otherwise. The dangerously-skip-permissions toggle is shown red with a confirmation (spec §9).
- **a11y floor (quality gate):** mobile-first responsive, visible keyboard focus on every interactive element, and `@media (prefers-reduced-motion: reduce)` disables the live-wire/streaming/sheet animations. Color is never the *only* signal (pair state color with text/icon).
- **Tooling:** Node v25.9.0, pnpm 11.8.0. The root `vitest.config.ts` globs `packages/*/test/**/*.test.ts` with `environment:"node"` — that is wrong for React component tests, so `packages/web` gets its OWN `vitest.config.ts` (jsdom env, its own `include`) and is run with `pnpm exec vitest run --config packages/web/vitest.config.ts` (or `pnpm -C packages/web test`). Do NOT add web tests to the root node-env config. Build: `pnpm -C packages/web build` (`vite build`). The web package is NOT part of the root `tsc -b` project references (it uses Vite/`vite build` + its own `tsc --noEmit` typecheck) — do not add it to root `tsconfig.json` references.

### Out of scope for Plan 4 (do NOT build — later/other plans)

- **Web Push notifications** ("permission needed" / "task done"). The server `push` component and the `POST` subscribe endpoint are NOT in Plan 3, so there is nothing to call. The PWA service worker is installed here, but push subscription/notification is deferred (note it in the manifest task). (Spec §6.2 push opt-in → later plan.)
- **Light theme.** Dark ships first (spec design direction "Light theme is optional/later"). Tokens are authored so a light theme can be added later, but no light theme is built.
- **Real-`claude` E2E.** All tests run against a mock server (or the Plan 3 server + interactive mock); CI never spends subscription credit or hits the network.
- **Distribution (Docker/Caddy/`npx`), README hero, CI wiring** → Plan 6.
- **Multi-user / accounts.** Single-user; one token.
- **Resume-across-restart UI affordances** beyond what the server already exposes (the client reads `GET /sessions/:id` history + reconnects WS; lazy respawn is a Plan-later server concern).

---

### Task 1: Design system + scaffold `packages/web` + static mockup screenshot (SIGN-OFF GATE)

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/tsconfig.node.json`
- Create: `packages/web/vite.config.ts`
- Create: `packages/web/vitest.config.ts`
- Create: `packages/web/index.html`
- Create: `packages/web/src/main.tsx`
- Create: `packages/web/src/styles/tokens.css`
- Create: `packages/web/src/styles/global.css`
- Create: `packages/web/src/ui/Button.tsx`
- Create: `packages/web/src/ui/Surface.tsx`
- Create: `packages/web/src/ui/Mono.tsx`
- Create: `packages/web/src/ui/LiveWire.tsx`
- Create: `packages/web/src/ui/LiveWire.test.tsx`
- Create: `packages/web/src/mockup/MockupPage.tsx`
- Create: `packages/web/src/mockup/mock-data.ts`
- Create: `packages/web/test/setup.ts`
- Create: `packages/web/scripts/screenshot.mjs`
- Create: `docs/design/` (output dir for the screenshots — created by the script)
- Modify: `pnpm-workspace.yaml` is already `packages/*` (no change needed — verify only)

**Interfaces:**
- Consumes: nothing (new package).
- Produces (later tasks rely on these exact names/props):
  - Design tokens as CSS custom properties on `:root` in `tokens.css` (exact values below) — referenced by every component via `var(--…)`.
  - `Button` — `props: { variant?: "primary"|"ghost"|"danger"; type?: "button"|"submit"; disabled?: boolean; onClick?: () => void; "aria-label"?: string; children: React.ReactNode }`. Visible focus ring; `danger` is the red destructive style.
  - `Surface` — `props: { level?: 1|2; as?: "div"|"section"|"article"; className?: string; children: React.ReactNode }` (level 1 → `--surface`, level 2 → `--surface-2`).
  - `Mono` — `props: { children: React.ReactNode; muted?: boolean; className?: string }` — a `<span>` in JetBrains Mono for paths/ids/tool names.
  - `LiveWire` — `props: { state: "idle"|"thinking"|"streaming"|"awaiting"|"running-tool"|"success"|"error"; "aria-label"?: string }`. A slim animated signal. State→color: thinking/streaming = `--accent` (amber, pulses); awaiting = `--iris` (the rare attention color); running-tool = `--cyan`; success = `--ok`; error = `--err`; idle = `--text-muted` (no animation). It renders an accessible status (`role="status"`) with a text label so color is not the only signal, and it respects `prefers-reduced-motion`.

**Design tokens (bake in VERBATIM — `tokens.css`):**
```css
:root {
  color-scheme: dark;
  /* Surfaces — cool ink, not pure black */
  --bg: #0E1116;
  --surface: #161B22;
  --surface-2: #1C232C;
  --border: #262E38;
  /* Text */
  --text: #E6EDF3;
  --text-muted: #8B98A5;
  /* Brand / signal accent — warm amber (Claude-warm) */
  --accent: #E8A33D;
  /* Semantic STATE colors — used as small dots/edges, NOT fills */
  --iris: #C9A2FF;   /* awaiting-you (permission/question) — the ONE rare attention color */
  --cyan: #5AC8E8;   /* running-tool */
  --ok: #5AD19A;     /* success */
  --err: #F2685C;    /* error */
  /* Type scale (rem) */
  --fs-xs: 0.75rem;  --fs-sm: 0.875rem; --fs-base: 1rem;
  --fs-lg: 1.125rem; --fs-xl: 1.375rem; --fs-2xl: 1.75rem;
  /* Fonts */
  --font-display: "Space Grotesk", system-ui, sans-serif; /* headings, wordmark, labels */
  --font-body: "Inter", system-ui, sans-serif;            /* body */
  --font-mono: "JetBrains Mono", ui-monospace, monospace; /* paths, ids, tools, code, picker */
  /* Spacing + radius */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
  --radius: 10px; --radius-sm: 6px;
  /* Layout */
  --tap-min: 44px; /* minimum touch target */
  --rail-w: 300px; /* desktop session rail */
}
```

- [ ] **Step 1: Create the package manifest**

`packages/web/package.json`:
```json
{
  "name": "@roamcode/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --config vitest.config.ts"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.0",
    "react-markdown": "^9.0.1",
    "shiki": "^1.22.0",
    "@fontsource/space-grotesk": "^5.1.0",
    "@fontsource/inter": "^5.1.0",
    "@fontsource/jetbrains-mono": "^5.1.0"
  },
  "devDependencies": {
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.1",
    "vite-plugin-pwa": "^0.20.5",
    "typescript": "^5.6.2",
    "@types/react": "^18.3.10",
    "@types/react-dom": "^18.3.0",
    "vitest": "^2.1.1",
    "jsdom": "^25.0.1",
    "@testing-library/react": "^16.0.1",
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/user-event": "^14.5.2"
  }
}
```

- [ ] **Step 2: Create the TypeScript configs**

`packages/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`packages/web/tsconfig.node.json` (kept minimal — the Vite config is type-checked by the main config's `include`; this file exists so editors that expect it don't error):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "composite": false, "noEmit": true, "module": "ESNext", "moduleResolution": "Bundler" },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 3: Create the Vite + Vitest configs and the test setup**

`packages/web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5273 },
});
```

`packages/web/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    css: false,
  },
});
```

`packages/web/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Create the HTML entry and global styles**

`packages/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0E1116" />
    <title>roamcode</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `packages/web/src/styles/tokens.css` with EXACTLY the token block from the "Design tokens" section above (copy it verbatim).

`packages/web/src/styles/global.css`:
```css
@import "@fontsource/space-grotesk/400.css";
@import "@fontsource/space-grotesk/600.css";
@import "@fontsource/inter/400.css";
@import "@fontsource/inter/500.css";
@import "@fontsource/jetbrains-mono/400.css";
@import "./tokens.css";

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: var(--fs-base);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, .display { font-family: var(--font-display); font-weight: 600; }
button { font-family: inherit; }
/* Visible keyboard focus everywhere (a11y floor) */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
}
```

- [ ] **Step 5: Write the `LiveWire` component test (the signature element)**

`packages/web/src/ui/LiveWire.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveWire } from "./LiveWire";

describe("LiveWire", () => {
  it("exposes an accessible status with a text label (color is not the only signal)", () => {
    render(<LiveWire state="awaiting" />);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    // The awaiting state must carry readable text, not just the iris color.
    expect(status).toHaveTextContent(/awaiting/i);
  });

  it("sets a data-state attribute the CSS keys color/animation off", () => {
    const { rerender } = render(<LiveWire state="streaming" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "streaming");
    rerender(<LiveWire state="idle" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "idle");
  });

  it("honors an explicit aria-label override", () => {
    render(<LiveWire state="thinking" aria-label="Session alpha is thinking" />);
    expect(screen.getByLabelText("Session alpha is thinking")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/ui/LiveWire.test.tsx`
Expected: FAIL — `LiveWire` does not exist (module not found). (If pnpm has not installed yet, this also fails on missing deps — Step 8 installs.)

- [ ] **Step 7: Implement the primitives**

`packages/web/src/ui/Button.tsx`:
```tsx
import type { ReactNode } from "react";

export interface ButtonProps {
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  "aria-label"?: string;
  className?: string;
  children: ReactNode;
}

const base: React.CSSProperties = {
  minHeight: "var(--tap-min)",
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border)",
  font: "inherit",
  fontWeight: 500,
  cursor: "pointer",
};

const variants: Record<NonNullable<ButtonProps["variant"]>, React.CSSProperties> = {
  primary: { background: "var(--accent)", color: "#1A1206", borderColor: "var(--accent)" },
  ghost: { background: "transparent", color: "var(--text)" },
  danger: { background: "transparent", color: "var(--err)", borderColor: "var(--err)" },
};

export function Button({ variant = "ghost", type = "button", disabled, onClick, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={className}
      aria-label={rest["aria-label"]}
      style={{ ...base, ...variants[variant], opacity: disabled ? 0.5 : 1 }}
    >
      {children}
    </button>
  );
}
```

`packages/web/src/ui/Surface.tsx`:
```tsx
import type { ReactNode } from "react";

export interface SurfaceProps {
  level?: 1 | 2;
  as?: "div" | "section" | "article";
  className?: string;
  children: ReactNode;
}

export function Surface({ level = 1, as = "div", className, children }: SurfaceProps) {
  const Tag = as;
  return (
    <Tag
      className={className}
      style={{
        background: level === 1 ? "var(--surface)" : "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      }}
    >
      {children}
    </Tag>
  );
}
```

`packages/web/src/ui/Mono.tsx`:
```tsx
import type { ReactNode } from "react";

export interface MonoProps {
  children: ReactNode;
  muted?: boolean;
  className?: string;
}

export function Mono({ children, muted, className }: MonoProps) {
  return (
    <span className={className} style={{ fontFamily: "var(--font-mono)", color: muted ? "var(--text-muted)" : "inherit" }}>
      {children}
    </span>
  );
}
```

`packages/web/src/ui/LiveWire.tsx`:
```tsx
export type LiveWireState =
  | "idle" | "thinking" | "streaming" | "awaiting" | "running-tool" | "success" | "error";

const LABELS: Record<LiveWireState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  streaming: "Streaming",
  awaiting: "Awaiting you",
  "running-tool": "Running tool",
  success: "Done",
  error: "Error",
};

const COLORS: Record<LiveWireState, string> = {
  idle: "var(--text-muted)",
  thinking: "var(--accent)",
  streaming: "var(--accent)",
  awaiting: "var(--iris)",
  "running-tool": "var(--cyan)",
  success: "var(--ok)",
  error: "var(--err)",
};

export interface LiveWireProps {
  state: LiveWireState;
  "aria-label"?: string;
}

/**
 * The session's signature "live wire": a slim signal whose color + motion encode the
 * remote link's state. The pulse animation (defined in global/inline CSS) is disabled
 * under prefers-reduced-motion via the global stylesheet. Color is paired with a text
 * label so it is never the sole signal (a11y).
 */
export function LiveWire({ state, ...rest }: LiveWireProps) {
  const animated = state === "thinking" || state === "streaming" || state === "awaiting";
  const color = COLORS[state];
  return (
    <span
      role="status"
      aria-label={rest["aria-label"] ?? LABELS[state]}
      data-state={state}
      style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)", color }}
    >
      <span
        aria-hidden
        style={{
          width: 8, height: 8, borderRadius: "50%", background: color,
          boxShadow: `0 0 6px ${animated ? color : "transparent"}`,
          animation: animated ? "rc-pulse 1.2s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ color: "var(--text-muted)" }}>{LABELS[state]}</span>
      <style>{`@keyframes rc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
    </span>
  );
}
```

- [ ] **Step 8: Install dependencies**

Run: `pnpm install`
Expected: pnpm resolves and links the new `@roamcode/web` package and its deps. Success when pnpm prints `Done`. (Run from the repo root so the workspace picks up the new package.)

- [ ] **Step 9: Run the LiveWire test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/ui/LiveWire.test.tsx`
Expected: PASS (3 cases). If "module not found" persists, confirm Step 8 installed and `@vitejs/plugin-react` is present.

- [ ] **Step 10: Build the static mockup page (two key screens with mock data)**

`packages/web/src/mockup/mock-data.ts`:
```ts
import type { LiveWireState } from "../ui/LiveWire";

export interface MockSession { id: string; name: string; cwd: string; branch?: string; state: LiveWireState; }

export const MOCK_SESSIONS: MockSession[] = [
  { id: "7bd0a4b6-0924-46fc-b9d3-d8f33105e37b", name: "roamcode", cwd: "~/Developer/roamcode", branch: "main", state: "awaiting" },
  { id: "a1c2e3f4-1111-2222-3333-444455556666", name: "api-gateway", cwd: "~/work/api-gateway", branch: "feat/rate-limit", state: "streaming" },
  { id: "b2d3f4a5-7777-8888-9999-000011112222", name: "notes", cwd: "~/notes", state: "idle" },
];

export interface MockDir { name: string; path: string; isGitRepo: boolean; branch?: string; }
export const MOCK_RECENTS: MockDir[] = [
  { name: "roamcode", path: "~/Developer/roamcode", isGitRepo: true, branch: "main" },
  { name: "api-gateway", path: "~/work/api-gateway", isGitRepo: true, branch: "feat/rate-limit" },
];
export const MOCK_DIR_LISTING: MockDir[] = [
  { name: "packages", path: "~/Developer/roamcode/packages", isGitRepo: false },
  { name: "docs", path: "~/Developer/roamcode/docs", isGitRepo: false },
  { name: "infra", path: "~/Developer/infra", isGitRepo: true, branch: "prod" },
];
```

`packages/web/src/mockup/MockupPage.tsx`:
```tsx
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { LiveWire } from "../ui/LiveWire";
import { MOCK_SESSIONS, MOCK_RECENTS, MOCK_DIR_LISTING } from "./mock-data";

/**
 * Static, data-mocked preview of the two key screens for design sign-off:
 *  (A) the chat view mid-session with an "awaiting you" permission prompt,
 *  (B) the directory picker sheet.
 * This page is NOT wired to any store/API — it exists only so Task 1 can be screenshotted.
 */
export function MockupPage() {
  return (
    <div style={{ display: "grid", gap: "var(--sp-6)", padding: "var(--sp-5)", maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <span className="display" style={{ fontSize: "var(--fs-2xl)" }}>roamcode</span>
        <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>mission control</span>
      </header>

      {/* (A) Chat view mid-session with an awaiting-you permission prompt */}
      <Surface level={1} as="section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "var(--sp-4)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
            <strong className="display">roamcode</strong>
            <Mono muted>~/Developer/roamcode · <span style={{ color: "var(--accent)" }}>main</span></Mono>
          </div>
          <LiveWire state="awaiting" aria-label="Session is awaiting your decision" />
        </div>
        <div style={{ padding: "var(--sp-4)", display: "grid", gap: "var(--sp-4)" }}>
          <div style={{ color: "var(--text)" }}>I'll create <Mono>spike.txt</Mono> with the captured protocol notes, then run the tests.</div>
          <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", color: "var(--cyan)", fontSize: "var(--fs-sm)" }}>
            <Mono>Write</Mono><span style={{ color: "var(--text-muted)" }}>· /private/tmp/rc-spike/spike.txt</span>
          </div>
          {/* The iris "awaiting you" moment */}
          <Surface level={2} as="article">
            <div style={{ padding: "var(--sp-4)", borderLeft: "3px solid var(--iris)", display: "grid", gap: "var(--sp-3)" }}>
              <div style={{ color: "var(--iris)", fontFamily: "var(--font-display)" }}>Awaiting you — permission</div>
              <div>Allow <Mono>Write</Mono> to <Mono muted>/private/tmp/rc-spike/spike.txt</Mono>?</div>
              <div style={{ display: "flex", gap: "var(--sp-3)" }}>
                <Button variant="primary">Allow</Button>
                <Button variant="ghost">Deny</Button>
              </div>
            </div>
          </Surface>
        </div>
        <div style={{ padding: "var(--sp-4)", borderTop: "1px solid var(--border)", display: "flex", gap: "var(--sp-2)" }}>
          <input placeholder="Message claude…" style={{ flex: 1, minHeight: "var(--tap-min)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text)", padding: "0 var(--sp-3)" }} />
          <Button variant="primary" aria-label="Send">Send</Button>
        </div>
      </Surface>

      {/* (B) Directory picker sheet */}
      <Surface level={1} as="section">
        <div style={{ padding: "var(--sp-4)", borderBottom: "1px solid var(--border)" }}>
          <strong className="display">Pick a directory</strong>
          <div style={{ marginTop: "var(--sp-2)" }}>
            <input placeholder="Filter directories…" style={{ width: "100%", minHeight: "var(--tap-min)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text)", padding: "0 var(--sp-3)", fontFamily: "var(--font-mono)" }} />
          </div>
          <div style={{ marginTop: "var(--sp-2)", color: "var(--text-muted)" }}><Mono>~/Developer/roamcode</Mono></div>
        </div>
        <div style={{ padding: "var(--sp-4)", display: "grid", gap: "var(--sp-4)" }}>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1 }}>Recents</div>
            {MOCK_RECENTS.map((d) => (
              <div key={d.path} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: "var(--tap-min)", borderBottom: "1px solid var(--border)" }}>
                <Mono>{d.path}</Mono>
                {d.isGitRepo && <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>git:{d.branch}</span>}
              </div>
            ))}
          </div>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1 }}>Browse</div>
            {MOCK_DIR_LISTING.map((d) => (
              <div key={d.path} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: "var(--tap-min)", borderBottom: "1px solid var(--border)" }}>
                <Mono>{d.name}/</Mono>
                {d.isGitRepo && <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>git:{d.branch}</span>}
              </div>
            ))}
          </div>
        </div>
      </Surface>

      {/* Session rail preview (state colors) */}
      <Surface level={1} as="section">
        <div style={{ padding: "var(--sp-4)", display: "grid", gap: "var(--sp-3)" }}>
          {MOCK_SESSIONS.map((s) => (
            <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div><strong>{s.name}</strong> <Mono muted>{s.cwd}</Mono></div>
              <LiveWire state={s.state} />
            </div>
          ))}
        </div>
      </Surface>
    </div>
  );
}
```

`packages/web/src/main.tsx` (for Task 1 this renders the mockup; Task 2 replaces the rendered root with the real `<App/>`):
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { MockupPage } from "./mockup/MockupPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MockupPage />
  </StrictMode>,
);
```

- [ ] **Step 11: Write the screenshot script**

`packages/web/scripts/screenshot.mjs` (builds the app, serves `dist/` on an ephemeral port, captures desktop + mobile PNGs into `docs/design/`, then exits):
```js
// Screenshots the static mockup for design sign-off. Uses Playwright's bundled Chromium.
// Run: node packages/web/scripts/screenshot.mjs  (after `pnpm -C packages/web build`)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
const outDir = join(__dirname, "..", "..", "..", "docs", "design");
mkdirSync(outDir, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

const server = createServer(async (req, res) => {
  try {
    const urlPath = (req.url ?? "/").split("?")[0];
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
    const file = join(distDir, rel);
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA fallback to index.html
    try {
      const data = await readFile(join(distDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const base = `http://127.0.0.1:${port}/`;

// Playwright is invoked via its package; if unavailable, the executor may swap in
// the chrome-devtools MCP take_screenshot against `base` instead (see Step 12).
const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  await desktop.goto(base, { waitUntil: "networkidle" });
  await desktop.screenshot({ path: join(outDir, "2026-06-23-pwa-mockup-desktop.png"), fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 1800 }, deviceScaleFactor: 2 });
  await mobile.goto(base, { waitUntil: "networkidle" });
  await mobile.screenshot({ path: join(outDir, "2026-06-23-pwa-mockup-mobile.png"), fullPage: true });
  console.log(`Saved screenshots to ${outDir}`);
} finally {
  await browser.close();
  server.close();
}
```

- [ ] **Step 12: Build and capture the screenshots**

Run:
```bash
pnpm -C packages/web build
node packages/web/scripts/screenshot.mjs
```
Expected: `pnpm -C packages/web build` produces `packages/web/dist/` (`vite build` after a clean `tsc --noEmit`). The script writes `docs/design/2026-06-23-pwa-mockup-desktop.png` and `docs/design/2026-06-23-pwa-mockup-mobile.png`.

**If `playwright` is not installed** (the dynamic import throws), capture the same two screens with the chrome-devtools MCP instead: start a static server with `node packages/web/scripts/screenshot.mjs` will have failed before serving, so run `pnpm -C packages/web preview --port 5273` in the background, then use the MCP tools `navigate_page` to `http://127.0.0.1:5273/`, `resize_page` to 1280×1400, `take_screenshot` (save to `docs/design/2026-06-23-pwa-mockup-desktop.png`), then resize to 390×844 and `take_screenshot` to `docs/design/2026-06-23-pwa-mockup-mobile.png`. Either path satisfies this step; the deliverable is the two PNGs in `docs/design/`.

- [ ] **Step 13: Typecheck**

Run: `pnpm -C packages/web typecheck`
Expected: PASS (no type errors). If `vite/client` types are missing, confirm `"types": ["vite/client", …]` in `tsconfig.json`.

- [ ] **Step 14: Commit + STOP for sign-off**

```bash
git add packages/web docs/design pnpm-lock.yaml
git commit -m "feat(web): design system + primitives + LiveWire + static mockup screenshots"
```

**SIGN-OFF GATE:** This task's deliverable is the design system + the two screenshots in `docs/design/`. The controller relays the screenshots to the user for sign-off **before** the rest of the PWA is built. Do not proceed to Task 2 until the design direction is confirmed (or revise tokens/mockup per feedback and re-screenshot).

---

### Task 2: Shared server-contract types + auth/login screen + app shell

**Files:**
- Create: `packages/web/src/types/server.ts`
- Create: `packages/web/src/auth/token-store.ts`
- Create: `packages/web/src/auth/token-store.test.ts`
- Create: `packages/web/src/auth/LoginScreen.tsx`
- Create: `packages/web/src/auth/LoginScreen.test.tsx`
- Create: `packages/web/src/App.tsx`
- Modify: `packages/web/src/main.tsx` (render `<App/>` instead of the mockup)

**Interfaces:**
- Consumes (Task 1): `Button`, `Surface`, `Mono`.
- Produces (every later task relies on these — they are the client-side mirror of the Plan 3 server contract):
  - In `types/server.ts` (mirror the server's exported shapes EXACTLY — these are NOT imported from `@roamcode/server` to avoid bundling Node code into the browser):
    - `type ServerFrameKind = "event" | "permission" | "result" | "diagnostic" | "exit"`.
    - `interface ServerFrame { seq: number; kind: ServerFrameKind; payload: unknown }`.
    - `interface SessionMeta { id: string; cwd: string; model?: string; effort?: string; dangerouslySkip: boolean; status: "running" | "errored" | "stopped"; createdAt: number }`.
    - `interface DirEntry { name: string; path: string; isDirectory: boolean; isGitRepo: boolean; gitBranch?: string }`.
    - `interface DirListing { path: string; parent?: string; entries: DirEntry[] }`.
    - `type ContentBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }`.
    - `interface PermissionPayload { requestId: string; kind: "hook_callback" | "can_use_tool"; toolName?: string; toolInput?: unknown; toolUseId?: string }` (the `payload` of a `kind:"permission"` frame).
    - `interface ResultPayload { type: "result"; subtype?: string; isError?: boolean; result?: string; sessionId?: string; totalCostUsd?: number; permissionDenials?: unknown[]; raw: unknown }` (the `payload` of a `kind:"result"` frame).
    - `interface DiagnosticPayload { source: "stderr" | "parser"; message: string }`.
    - Client→server WS frames: `type OutboundFrame = { type: "user"; content?: string; blocks?: ContentBlock[]; text?: string; images?: { mediaType: string; dataBase64: string }[] } | { type: "permission"; requestId: string; decision: "allow" | "deny"; reason?: string }`.
  - In `token-store.ts`: `function loadToken(): string | undefined`; `function saveToken(token: string): void`; `function clearToken(): void`. Backed by `localStorage` key `"roamcode.token"`. (Document the XSS caveat in a comment.)
  - `LoginScreen` — `props: { onAuthenticated: (token: string) => void; initialError?: string }`. A token field + "Connect" button; on submit it calls `onAuthenticated(token)` (the parent validates against the server in Task 3). Shows `initialError` (e.g. a 401 message). Also offers a "Connect without a token (local dev)" action that calls `onAuthenticated("")`.
  - `App` — the root component: if no token is stored, render `LoginScreen`; once a token is present, render a placeholder shell (`<div>connected</div>` for now — Task 4 swaps in the real layout). Stores/clears the token via `token-store`.

- [ ] **Step 1: Write the token-store test**

`packages/web/src/auth/token-store.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadToken, saveToken, clearToken } from "./token-store";

afterEach(() => localStorage.clear());

describe("token-store", () => {
  it("returns undefined when nothing is stored", () => {
    expect(loadToken()).toBeUndefined();
  });
  it("round-trips a saved token", () => {
    saveToken("s3cret");
    expect(loadToken()).toBe("s3cret");
  });
  it("clears the token", () => {
    saveToken("s3cret");
    clearToken();
    expect(loadToken()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/auth/token-store.test.ts`
Expected: FAIL — `token-store` does not exist.

- [ ] **Step 3: Write the server types and the token store**

`packages/web/src/types/server.ts`:
```ts
// Client-side mirror of the Plan 3 server contract (packages/server/src/transport.ts,
// session-hub.ts, replay-buffer.ts, fs-service.ts). Kept as a standalone type module so the
// browser bundle never imports the Node server package.

export type ServerFrameKind = "event" | "permission" | "result" | "diagnostic" | "exit";

export interface ServerFrame {
  seq: number;
  kind: ServerFrameKind;
  payload: unknown;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkip: boolean;
  status: "running" | "errored" | "stopped";
  createdAt: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  gitBranch?: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface PermissionPayload {
  requestId: string;
  kind: "hook_callback" | "can_use_tool";
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
}

export interface ResultPayload {
  type: "result";
  subtype?: string;
  isError?: boolean;
  result?: string;
  sessionId?: string;
  totalCostUsd?: number;
  permissionDenials?: unknown[];
  raw: unknown;
}

export interface DiagnosticPayload {
  source: "stderr" | "parser";
  message: string;
}

export type OutboundFrame =
  | {
      type: "user";
      content?: string;
      blocks?: ContentBlock[];
      text?: string;
      images?: { mediaType: string; dataBase64: string }[];
    }
  | { type: "permission"; requestId: string; decision: "allow" | "deny"; reason?: string };
```

`packages/web/src/auth/token-store.ts`:
```ts
// SECURITY: the access token is stored in localStorage — readable by any script in this
// origin (XSS-exposed). This is an accepted trade-off for a single-user self-hosted tool
// (spec §9). Do not store anything more sensitive here.
const KEY = "roamcode.token";

export function loadToken(): string | undefined {
  const v = localStorage.getItem(KEY);
  return v === null ? undefined : v;
}

export function saveToken(token: string): void {
  localStorage.setItem(KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}
```

- [ ] **Step 4: Run the token-store test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/auth/token-store.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Write the LoginScreen test**

`packages/web/src/auth/LoginScreen.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen";

describe("LoginScreen", () => {
  it("submits the entered token", async () => {
    const onAuth = vi.fn();
    render(<LoginScreen onAuthenticated={onAuth} />);
    await userEvent.type(screen.getByLabelText(/access token/i), "my-token");
    await userEvent.click(screen.getByRole("button", { name: /connect$/i }));
    expect(onAuth).toHaveBeenCalledWith("my-token");
  });

  it("shows an initial error (e.g. a prior 401)", () => {
    render(<LoginScreen onAuthenticated={vi.fn()} initialError="Invalid token (401)" />);
    expect(screen.getByText(/invalid token \(401\)/i)).toBeInTheDocument();
  });

  it("offers a tokenless local-dev connect", async () => {
    const onAuth = vi.fn();
    render(<LoginScreen onAuthenticated={onAuth} />);
    await userEvent.click(screen.getByRole("button", { name: /without a token/i }));
    expect(onAuth).toHaveBeenCalledWith("");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/auth/LoginScreen.test.tsx`
Expected: FAIL — `LoginScreen` does not exist.

- [ ] **Step 7: Write `LoginScreen`**

`packages/web/src/auth/LoginScreen.tsx`:
```tsx
import { useState } from "react";
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";

export interface LoginScreenProps {
  onAuthenticated: (token: string) => void;
  initialError?: string;
}

export function LoginScreen({ onAuthenticated, initialError }: LoginScreenProps) {
  const [token, setToken] = useState("");
  return (
    <div style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: "var(--sp-5)" }}>
      <Surface level={1} as="section">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onAuthenticated(token);
          }}
          style={{ padding: "var(--sp-5)", display: "grid", gap: "var(--sp-4)", width: "min(92vw, 420px)" }}
        >
          <div className="display" style={{ fontSize: "var(--fs-2xl)" }}>roamcode</div>
          <p style={{ color: "var(--text-muted)", margin: 0, fontSize: "var(--fs-sm)" }}>
            Enter the access token from your server to connect.
          </p>
          {initialError && (
            <div role="alert" style={{ color: "var(--err)", fontSize: "var(--fs-sm)" }}>{initialError}</div>
          )}
          <label style={{ display: "grid", gap: "var(--sp-2)" }}>
            <span style={{ fontSize: "var(--fs-sm)" }}>Access token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              style={{ minHeight: "var(--tap-min)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text)", padding: "0 var(--sp-3)", fontFamily: "var(--font-mono)" }}
            />
          </label>
          <Button type="submit" variant="primary">Connect</Button>
          <Button type="button" variant="ghost" onClick={() => onAuthenticated("")}>
            Connect without a token (local dev)
          </Button>
          <p style={{ color: "var(--text-muted)", margin: 0, fontSize: "var(--fs-xs)" }}>
            The token is stored in this browser only (localStorage).
          </p>
        </form>
      </Surface>
    </div>
  );
}
```

- [ ] **Step 8: Write `App` and re-point `main.tsx`**

`packages/web/src/App.tsx`:
```tsx
import { useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { loadToken, saveToken } from "./auth/token-store";

export function App() {
  const [token, setToken] = useState<string | undefined>(() => loadToken());

  if (token === undefined) {
    return (
      <LoginScreen
        onAuthenticated={(t) => {
          saveToken(t);
          setToken(t);
        }}
      />
    );
  }
  // Task 4 replaces this with the real session-list + chat layout.
  return <div>connected</div>;
}
```

In `packages/web/src/main.tsx`, replace the mockup import + render. Change:
```tsx
import { MockupPage } from "./mockup/MockupPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MockupPage />
  </StrictMode>,
);
```
to:
```tsx
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```
(The mockup files stay in the repo for reference but are no longer the app entry.)

- [ ] **Step 9: Run the tests + typecheck**

Run: `pnpm -C packages/web exec vitest run src/auth`
Expected: PASS (token-store 3 + LoginScreen 3). Then `pnpm -C packages/web typecheck` → PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/types packages/web/src/auth packages/web/src/App.tsx packages/web/src/main.tsx
git commit -m "feat(web): server-contract types + token store + login screen + app shell"
```

---

### Task 3: REST `api` client + reconnecting `ws` client + Zustand store

**Files:**
- Create: `packages/web/src/api/client.ts`
- Create: `packages/web/src/api/client.test.ts`
- Create: `packages/web/src/ws/session-socket.ts`
- Create: `packages/web/src/ws/session-socket.test.ts`
- Create: `packages/web/src/store/store.ts`
- Create: `packages/web/src/store/frame-reducer.ts`
- Create: `packages/web/src/store/frame-reducer.test.ts`

**Interfaces:**
- Consumes (Task 2): all types from `types/server.ts`; `loadToken`.
- Produces (Tasks 4–11 rely on these):
  - `interface ApiClient` from a factory `createApiClient(opts: { baseUrl: string; getToken: () => string | undefined }): ApiClient` with methods:
    - `listSessions(): Promise<SessionMeta[]>`
    - `getSession(id: string): Promise<{ session: SessionMeta; history: ServerFrame[] }>`
    - `createSession(body: { cwd: string; model?: string; effort?: string; addDirs?: string[]; dangerouslySkip?: boolean }): Promise<SessionMeta>`
    - `stopSession(id: string): Promise<void>`
    - `listDir(path?: string): Promise<DirListing>`
    - `uploadFile(dir: string, file: File): Promise<{ path: string }>`
    - `downloadUrl(path: string): string` (a URL string with `?path=` and, if a token exists, `&token=` — for `<a href>`/`<img src>`)
    - Each request sends `Authorization: Bearer <token>` when a token exists; a `401` throws an `ApiError` with `.status === 401`.
  - `class ApiError extends Error { status: number }`.
  - `function wsUrl(baseUrl: string, id: string, opts: { token?: string; since?: number }): string` — builds `ws(s)://…/sessions/:id/ws?token=…&since=…` (omits absent params; converts an `http(s)://` base to `ws(s)://`).
  - `class SessionSocket` from `createSessionSocket(opts: { url: string; onFrame: (f: ServerFrame) => void; onStatus: (s: "connecting"|"open"|"closed") => void; getSince: () => number | undefined; WebSocketImpl?: typeof WebSocket })` — opens a WS, parses each message as a `ServerFrame` → `onFrame`, and on close auto-reconnects with backoff, passing `getSince()` so the URL carries `?since=<lastSeq>`. `close()` stops reconnects. `send(frame: OutboundFrame): void` serializes and sends (no-op if not open). `WebSocketImpl` is injectable for tests.
  - The Zustand store `useStore` (from `store/store.ts`) holding: `token`, `sessions: SessionMeta[]`, `activeSessionId?`, and per-session derived view-state (`SessionView`) computed by `frame-reducer`. Plus actions: `setToken`, `setSessions`, `setActive`, `applyFrame(id, frame)`, `resetSession(id)`.
  - `frame-reducer.ts`: `interface SessionView { liveText: string; thinkingText: string; turns: TurnItem[]; pendingPermission?: PermissionPayload; lastResult?: ResultPayload; diagnostics: DiagnosticPayload[]; wireState: LiveWireState; lastSeq: number }` and `function reduceFrame(view: SessionView, frame: ServerFrame): SessionView` (pure) + `function emptyView(): SessionView`. `TurnItem` = `{ kind: "assistant-text"; text: string } | { kind: "tool-use"; id: string; name: string; input: unknown } | { kind: "tool-result"; toolUseId: string; content: unknown } | { kind: "user"; blocks: ContentBlock[] } | { kind: "result"; result?: string; isError?: boolean; totalCostUsd?: number }`.

- [ ] **Step 1: Write the API client test**

`packages/web/src/api/client.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, ApiError, wsUrl } from "./client";

const baseUrl = "http://127.0.0.1:4280";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ApiClient", () => {
  it("listSessions GETs /sessions with a bearer token and returns the array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1 }] }));
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    const sessions = await api.listSessions();
    expect(sessions).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/sessions`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("createSession POSTs the body and returns session", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: { id: "s2", cwd: "/x", dangerouslySkip: false, status: "running", createdAt: 2 } }, 201));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    const s = await api.createSession({ cwd: "/x", model: "opus" });
    expect(s.id).toBe("s2");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ cwd: "/x", model: "opus" });
  });

  it("throws ApiError with status 401 on unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const api = createApiClient({ baseUrl, getToken: () => "bad" });
    await expect(api.listSessions()).rejects.toMatchObject({ status: 401 });
    await expect(api.listSessions()).rejects.toBeInstanceOf(ApiError);
  });

  it("listDir GETs /fs/list with the path query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "/home", entries: [] }));
    const api = createApiClient({ baseUrl, getToken: () => undefined });
    await api.listDir("/home/u");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${baseUrl}/fs/list?path=${encodeURIComponent("/home/u")}`);
  });

  it("downloadUrl includes path and token", () => {
    const api = createApiClient({ baseUrl, getToken: () => "tok" });
    expect(api.downloadUrl("/home/u/a.txt")).toBe(`${baseUrl}/fs/download?path=${encodeURIComponent("/home/u/a.txt")}&token=tok`);
  });
});

describe("wsUrl", () => {
  it("builds a ws:// url with token and since", () => {
    expect(wsUrl("http://127.0.0.1:4280", "abc", { token: "t", since: 12 })).toBe("ws://127.0.0.1:4280/sessions/abc/ws?token=t&since=12");
  });
  it("omits absent params and upgrades https->wss", () => {
    expect(wsUrl("https://host", "abc", {})).toBe("wss://host/sessions/abc/ws");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/api/client.test.ts`
Expected: FAIL — `client` does not exist.

- [ ] **Step 3: Write the API client**

`packages/web/src/api/client.ts`:
```ts
import type { DirListing, ServerFrame, SessionMeta } from "../types/server";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface CreateSessionBody {
  cwd: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
}

export interface ApiClient {
  listSessions(): Promise<SessionMeta[]>;
  getSession(id: string): Promise<{ session: SessionMeta; history: ServerFrame[] }>;
  createSession(body: CreateSessionBody): Promise<SessionMeta>;
  stopSession(id: string): Promise<void>;
  listDir(path?: string): Promise<DirListing>;
  uploadFile(dir: string, file: File): Promise<{ path: string }>;
  downloadUrl(path: string): string;
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | undefined;
}

export function wsUrl(baseUrl: string, id: string, opts: { token?: string; since?: number }): string {
  const wsBase = baseUrl.replace(/^http/, "ws");
  const params = new URLSearchParams();
  if (opts.token) params.set("token", opts.token);
  if (opts.since !== undefined) params.set("since", String(opts.since));
  const qs = params.toString();
  return `${wsBase}/sessions/${id}/ws${qs ? `?${qs}` : ""}`;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const { baseUrl, getToken } = opts;

  function headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    const token = getToken();
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) {
      let message = `request failed (${res.status})`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // non-JSON error body — keep the default message
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as T;
  }

  return {
    async listSessions() {
      const body = await req<{ sessions: SessionMeta[] }>("/sessions", { headers: headers() });
      return body.sessions;
    },
    async getSession(id) {
      return req<{ session: SessionMeta; history: ServerFrame[] }>(`/sessions/${id}`, { headers: headers() });
    },
    async createSession(body) {
      const created = await req<{ session: SessionMeta }>("/sessions", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      return created.session;
    },
    async stopSession(id) {
      await req<{ ok: true }>(`/sessions/${id}/stop`, { method: "POST", headers: headers() });
    },
    async listDir(path) {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      return req<DirListing>(`/fs/list${qs}`, { headers: headers() });
    },
    async uploadFile(dir, file) {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch(`${baseUrl}/fs/upload?dir=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: headers(), // do NOT set content-type; the browser sets the multipart boundary
        body: form,
      });
      if (!res.ok) {
        let message = `upload failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // ignore
        }
        throw new ApiError(res.status, message);
      }
      return (await res.json()) as { path: string };
    },
    downloadUrl(path) {
      const token = getToken();
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
      return `${baseUrl}/fs/download?path=${encodeURIComponent(path)}${tokenParam}`;
    },
  };
}
```

- [ ] **Step 4: Run the API client test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/api/client.test.ts`
Expected: PASS (7 cases). If the bearer-header assertion fails, confirm `headers()` lower-cases `authorization` (the test matches `authorization`).

- [ ] **Step 5: Write the reconnecting-socket test**

`packages/web/src/ws/session-socket.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { createSessionSocket } from "./session-socket";
import type { ServerFrame } from "../types/server";

// A minimal fake WebSocket that lets the test drive open/message/close.
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  static OPEN = 1;
  OPEN = 1;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  _open() { this.readyState = 1; this.onopen?.(); }
  _message(frame: ServerFrame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

describe("SessionSocket", () => {
  it("parses frames and reports status", () => {
    FakeWS.instances = [];
    const frames: ServerFrame[] = [];
    const statuses: string[] = [];
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: (f) => frames.push(f),
      onStatus: (s) => statuses.push(s),
      getSince: () => undefined,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws = FakeWS.instances[0]!;
    ws._open();
    ws._message({ seq: 1, kind: "event", payload: { type: "system" } });
    expect(frames).toEqual([{ seq: 1, kind: "event", payload: { type: "system" } }]);
    expect(statuses).toContain("open");
    sock.close();
    expect(statuses).toContain("closed");
  });

  it("reconnects on unexpected close, carrying ?since from getSince()", () => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    let lastSeq = 0;
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: (f) => (lastSeq = f.seq),
      onStatus: () => {},
      getSince: () => (lastSeq > 0 ? lastSeq : undefined),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws = FakeWS.instances[0]!;
    ws._open();
    ws._message({ seq: 5, kind: "event", payload: {} });
    ws.close(); // unexpected close -> schedule a reconnect
    vi.runOnlyPendingTimers();
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1]!.url).toContain("since=5");
    sock.close();
    vi.useRealTimers();
  });

  it("send() serializes an outbound frame when open", () => {
    FakeWS.instances = [];
    const sock = createSessionSocket({
      url: "ws://x/sessions/a/ws",
      onFrame: () => {},
      onStatus: () => {},
      getSince: () => undefined,
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    const ws = FakeWS.instances[0]!;
    ws._open();
    sock.send({ type: "user", content: "hi" });
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "user", content: "hi" });
    sock.close();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/ws/session-socket.test.ts`
Expected: FAIL — `session-socket` does not exist.

- [ ] **Step 7: Write the reconnecting socket**

`packages/web/src/ws/session-socket.ts`:
```ts
import type { OutboundFrame, ServerFrame } from "../types/server";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SessionSocketOptions {
  url: string;
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: SocketStatus) => void;
  /** Returns the last applied seq so a reconnect can request `?since=<seq>` delta replay. */
  getSince: () => number | undefined;
  /** Injectable for tests; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

export interface SessionSocket {
  send(frame: OutboundFrame): void;
  close(): void;
}

const MAX_BACKOFF_MS = 10000;

/**
 * Reconnecting per-session WebSocket. On an unexpected close it reconnects with exponential
 * backoff, rebuilding the URL with `?since=<lastSeq>` (from getSince) so the server replays
 * only the frames missed while disconnected (spec §10 resilience). `close()` is final.
 */
export function createSessionSocket(opts: SessionSocketOptions): SessionSocket {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  let ws: WebSocket | undefined;
  let closedByUser = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function urlWithSince(): string {
    const since = opts.getSince();
    if (since === undefined) return opts.url;
    const sep = opts.url.includes("?") ? "&" : "?";
    // If the base url already carries a since, replace it; else append.
    return /[?&]since=/.test(opts.url)
      ? opts.url.replace(/([?&]since=)\d+/, `$1${since}`)
      : `${opts.url}${sep}since=${since}`;
  }

  function connect(): void {
    opts.onStatus("connecting");
    ws = new Impl(urlWithSince());
    ws.onopen = () => {
      attempt = 0;
      opts.onStatus("open");
    };
    ws.onmessage = (e: MessageEvent) => {
      try {
        const frame = JSON.parse(typeof e.data === "string" ? e.data : "") as ServerFrame;
        opts.onFrame(frame);
      } catch {
        // ignore malformed frames (defensive; server frames are always JSON)
      }
    };
    ws.onclose = () => {
      if (closedByUser) {
        opts.onStatus("closed");
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; let it drive the reconnect.
    };
  }

  function scheduleReconnect(): void {
    opts.onStatus("connecting");
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    send(frame: OutboundFrame) {
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    },
    close() {
      closedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
      else opts.onStatus("closed");
    },
  };
}
```
(Note: the backoff in the test runs via `vi.runOnlyPendingTimers()`; the first reconnect delay is `500 * 2**0 = 500ms`, which fake timers fast-forward.)

- [ ] **Step 8: Run the socket test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/ws/session-socket.test.ts`
Expected: PASS (3 cases). If the reconnect test sees only 1 instance, confirm `scheduleReconnect` uses `setTimeout` (driven by `vi.runOnlyPendingTimers()`), and that `close()` in the fake fires `onclose`.

- [ ] **Step 9: Write the frame-reducer test**

`packages/web/src/store/frame-reducer.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { ServerFrame } from "../types/server";

function ev(seq: number, payload: unknown): ServerFrame { return { seq, kind: "event", payload }; }

describe("reduceFrame", () => {
  it("accumulates streamed text_delta into liveText and sets wireState=streaming", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } }));
    v = reduceFrame(v, ev(2, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } }));
    expect(v.liveText).toBe("Hello");
    expect(v.wireState).toBe("streaming");
    expect(v.lastSeq).toBe(2);
  });

  it("commits a final assistant message into a turn and clears liveText", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } }));
    v = reduceFrame(v, ev(2, { type: "assistant", message: { content: [{ type: "text", text: "Hi there" }] } }));
    expect(v.liveText).toBe("");
    expect(v.turns.at(-1)).toEqual({ kind: "assistant-text", text: "Hi there" });
  });

  it("captures a tool_use turn and sets wireState=running-tool", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a" } }] } }));
    expect(v.turns.at(-1)).toEqual({ kind: "tool-use", id: "tu1", name: "Write", input: { file_path: "/a" } });
    expect(v.wireState).toBe("running-tool");
  });

  it("records a tool_result from a user event", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "done" }] } }));
    expect(v.turns.at(-1)).toEqual({ kind: "tool-result", toolUseId: "tu1", content: "done" });
  });

  it("sets pendingPermission on a permission frame (wireState=awaiting) and clears it on result", () => {
    let v = emptyView();
    v = reduceFrame(v, { seq: 1, kind: "permission", payload: { requestId: "r1", kind: "hook_callback", toolName: "Write" } });
    expect(v.pendingPermission?.requestId).toBe("r1");
    expect(v.wireState).toBe("awaiting");
    v = reduceFrame(v, { seq: 2, kind: "result", payload: { type: "result", result: "ok", permissionDenials: [] } });
    expect(v.pendingPermission).toBeUndefined();
    expect(v.wireState).toBe("success");
    expect(v.turns.at(-1)).toMatchObject({ kind: "result", result: "ok" });
  });

  it("sets wireState=error on an errored result and collects diagnostics", () => {
    let v = emptyView();
    v = reduceFrame(v, { seq: 1, kind: "diagnostic", payload: { source: "stderr", message: "auth expired" } });
    expect(v.diagnostics).toHaveLength(1);
    v = reduceFrame(v, { seq: 2, kind: "result", payload: { type: "result", isError: true, result: "boom" } });
    expect(v.wireState).toBe("error");
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/store/frame-reducer.test.ts`
Expected: FAIL — `frame-reducer` does not exist.

- [ ] **Step 11: Write the frame reducer**

`packages/web/src/store/frame-reducer.ts`:
```ts
import type { ContentBlock, DiagnosticPayload, PermissionPayload, ResultPayload, ServerFrame } from "../types/server";
import type { LiveWireState } from "../ui/LiveWire";

export type TurnItem =
  | { kind: "assistant-text"; text: string }
  | { kind: "tool-use"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; toolUseId: string; content: unknown }
  | { kind: "user"; blocks: ContentBlock[] }
  | { kind: "result"; result?: string; isError?: boolean; totalCostUsd?: number };

export interface SessionView {
  liveText: string;
  thinkingText: string;
  turns: TurnItem[];
  pendingPermission?: PermissionPayload;
  lastResult?: ResultPayload;
  diagnostics: DiagnosticPayload[];
  wireState: LiveWireState;
  lastSeq: number;
}

export function emptyView(): SessionView {
  return { liveText: "", thinkingText: "", turns: [], diagnostics: [], wireState: "idle", lastSeq: 0 };
}

interface DeltaEvent { type?: string; index?: number; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string } }
interface AssistantMsg { message?: { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> } }
interface UserMsg { message?: { content?: Array<{ type?: string; tool_use_id?: string; content?: unknown }> } }

/** Pure: fold one ServerFrame into the per-session view. Never throws on unknown shapes. */
export function reduceFrame(view: SessionView, frame: ServerFrame): SessionView {
  const next: SessionView = { ...view, lastSeq: Math.max(view.lastSeq, frame.seq) };

  if (frame.kind === "permission") {
    next.pendingPermission = frame.payload as PermissionPayload;
    next.wireState = "awaiting";
    return next;
  }
  if (frame.kind === "diagnostic") {
    next.diagnostics = [...view.diagnostics, frame.payload as DiagnosticPayload];
    return next;
  }
  if (frame.kind === "result") {
    const r = frame.payload as ResultPayload;
    next.lastResult = r;
    next.pendingPermission = undefined;
    next.liveText = "";
    next.thinkingText = "";
    next.wireState = r.isError ? "error" : "success";
    next.turns = [...view.turns, { kind: "result", result: r.result, isError: r.isError, totalCostUsd: r.totalCostUsd }];
    return next;
  }
  if (frame.kind === "exit") {
    next.wireState = "error";
    return next;
  }

  // kind === "event": an InboundEvent
  const ev = frame.payload as { type?: string } & DeltaEvent & AssistantMsg & UserMsg;
  if (ev.type === "stream_event") {
    const inner = (ev as { event?: DeltaEvent }).event;
    if (inner?.type === "content_block_delta" && inner.delta) {
      if (inner.delta.type === "text_delta" && inner.delta.text) {
        next.liveText = view.liveText + inner.delta.text;
        next.wireState = "streaming";
      } else if (inner.delta.type === "thinking_delta" && inner.delta.thinking) {
        next.thinkingText = view.thinkingText + inner.delta.thinking;
        next.wireState = "thinking";
      }
    }
    return next;
  }
  if (ev.type === "assistant") {
    const content = ev.message?.content ?? [];
    const turns = [...view.turns];
    let sawTool = false;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        turns.push({ kind: "assistant-text", text: block.text });
      } else if (block.type === "tool_use") {
        turns.push({ kind: "tool-use", id: String(block.id), name: String(block.name), input: block.input });
        sawTool = true;
      }
    }
    next.turns = turns;
    next.liveText = "";
    next.thinkingText = "";
    if (sawTool) next.wireState = "running-tool";
    return next;
  }
  if (ev.type === "user") {
    const content = ev.message?.content ?? [];
    const turns = [...view.turns];
    for (const block of content) {
      if (block.type === "tool_result") {
        turns.push({ kind: "tool-result", toolUseId: String(block.tool_use_id), content: block.content });
      }
    }
    next.turns = turns;
    return next;
  }
  if (ev.type === "system") {
    // init/status — no turn content; keep the view as-is (live link is alive).
    if (next.wireState === "idle") next.wireState = "thinking";
    return next;
  }
  return next;
}
```

- [ ] **Step 12: Run the reducer test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/store/frame-reducer.test.ts`
Expected: PASS (6 cases). If a `tool_result` case fails, confirm the `user` branch reads `block.tool_use_id` (snake_case, as the server forwards the raw protocol shape).

- [ ] **Step 13: Write the Zustand store**

`packages/web/src/store/store.ts`:
```ts
import { create } from "zustand";
import type { ServerFrame, SessionMeta } from "../types/server";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { SessionView } from "./frame-reducer";

interface StoreState {
  token: string | undefined;
  sessions: SessionMeta[];
  activeSessionId?: string;
  views: Record<string, SessionView>;
  setToken: (token: string | undefined) => void;
  setSessions: (sessions: SessionMeta[]) => void;
  setActive: (id: string | undefined) => void;
  applyFrame: (id: string, frame: ServerFrame) => void;
  resetSession: (id: string) => void;
  viewFor: (id: string) => SessionView;
}

export const useStore = create<StoreState>((set, get) => ({
  token: undefined,
  sessions: [],
  activeSessionId: undefined,
  views: {},
  setToken: (token) => set({ token }),
  setSessions: (sessions) => set({ sessions }),
  setActive: (id) => set({ activeSessionId: id }),
  applyFrame: (id, frame) =>
    set((state) => {
      const current = state.views[id] ?? emptyView();
      return { views: { ...state.views, [id]: reduceFrame(current, frame) } };
    }),
  resetSession: (id) => set((state) => ({ views: { ...state.views, [id]: emptyView() } })),
  viewFor: (id) => get().views[id] ?? emptyView(),
}));
```

- [ ] **Step 14: Typecheck + commit**

Run: `pnpm -C packages/web typecheck`
Expected: PASS.
```bash
git add packages/web/src/api packages/web/src/ws packages/web/src/store
git commit -m "feat(web): REST api client + reconnecting ws client + Zustand store/frame-reducer"
```

---

### Task 4: Session list + status, the app layout, and login→connect validation

**Files:**
- Create: `packages/web/src/config.ts`
- Create: `packages/web/src/session/SessionList.tsx`
- Create: `packages/web/src/session/SessionList.test.tsx`
- Create: `packages/web/src/session/status.ts`
- Create: `packages/web/src/session/status.test.ts`
- Create: `packages/web/src/AppLayout.tsx`
- Modify: `packages/web/src/App.tsx` (validate the token against the server; render the layout; handle 401 → back to login)

**Interfaces:**
- Consumes (Tasks 1–3): `Surface`, `Button`, `Mono`, `LiveWire` + `LiveWireState`; `createApiClient`, `ApiError`; `useStore`; `SessionMeta`; `loadToken`/`saveToken`/`clearToken`.
- Produces:
  - `config.ts`: `export const API_BASE_URL: string` — `import.meta.env.VITE_API_BASE_URL ?? window.location.origin` (so a deployed PWA talks to its own origin; dev can point elsewhere via the env var).
  - `status.ts`: `function wireStateForSession(meta: SessionMeta, view?: { wireState: LiveWireState }): LiveWireState` — if the session is `errored`/`stopped`, returns `"error"`/`"idle"`; otherwise returns the live `view.wireState` (default `"idle"`). So the rail dot reflects live activity for running sessions and terminal state otherwise.
  - `SessionList` — `props: { sessions: SessionMeta[]; activeId?: string; onSelect: (id: string) => void; onNew: () => void; viewWireState: (id: string) => LiveWireState }`. Renders each session (name from `cwd` basename, mono cwd, a `LiveWire` dot) as a large-tap-target row; a "New session" button. The active row is visually marked.
  - `AppLayout` — `props: { children: React.ReactNode; sessionList: React.ReactNode; onShowSessions?: () => void; sessionsOpen?: boolean }`. Mobile: single column with `children` (the conversation) full-bleed and the `sessionList` in a bottom sheet toggled by `sessionsOpen`. Desktop (≥768px): a left rail (`--rail-w`) with `sessionList` + a right pane with `children`. CSS-only responsive (a media query), no JS breakpoint logic required for the test.

- [ ] **Step 1: Write the status test**

`packages/web/src/session/status.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { wireStateForSession } from "./status";
import type { SessionMeta } from "../types/server";

function meta(status: SessionMeta["status"]): SessionMeta {
  return { id: "s", cwd: "/p", dangerouslySkip: false, status, createdAt: 1 };
}

describe("wireStateForSession", () => {
  it("maps errored -> error and stopped -> idle regardless of live view", () => {
    expect(wireStateForSession(meta("errored"), { wireState: "streaming" })).toBe("error");
    expect(wireStateForSession(meta("stopped"), { wireState: "streaming" })).toBe("idle");
  });
  it("uses the live view wireState for a running session", () => {
    expect(wireStateForSession(meta("running"), { wireState: "awaiting" })).toBe("awaiting");
    expect(wireStateForSession(meta("running"), undefined)).toBe("idle");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/session/status.test.ts`
Expected: FAIL — `status` does not exist.

- [ ] **Step 3: Write `status.ts` and `config.ts`**

`packages/web/src/session/status.ts`:
```ts
import type { SessionMeta } from "../types/server";
import type { LiveWireState } from "../ui/LiveWire";

export function wireStateForSession(meta: SessionMeta, view?: { wireState: LiveWireState }): LiveWireState {
  if (meta.status === "errored") return "error";
  if (meta.status === "stopped") return "idle";
  return view?.wireState ?? "idle";
}
```

`packages/web/src/config.ts`:
```ts
// The deployed PWA talks to its own origin; dev can override via VITE_API_BASE_URL.
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin;
```

- [ ] **Step 4: Run the status test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/session/status.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 5: Write the SessionList test**

`packages/web/src/session/SessionList.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionList } from "./SessionList";
import type { SessionMeta } from "../types/server";

const sessions: SessionMeta[] = [
  { id: "s1", cwd: "/home/u/roamcode", dangerouslySkip: false, status: "running", createdAt: 1 },
  { id: "s2", cwd: "/home/u/notes", dangerouslySkip: false, status: "stopped", createdAt: 2 },
];

describe("SessionList", () => {
  it("renders a row per session with its cwd basename and mono path", () => {
    render(<SessionList sessions={sessions} onSelect={vi.fn()} onNew={vi.fn()} viewWireState={() => "idle"} />);
    expect(screen.getByText("roamcode")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("/home/u/roamcode")).toBeInTheDocument();
  });

  it("calls onSelect when a row is activated", async () => {
    const onSelect = vi.fn();
    render(<SessionList sessions={sessions} onSelect={onSelect} onNew={vi.fn()} viewWireState={() => "idle"} />);
    await userEvent.click(screen.getByText("roamcode"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("calls onNew from the New session button", async () => {
    const onNew = vi.fn();
    render(<SessionList sessions={sessions} onSelect={vi.fn()} onNew={onNew} viewWireState={() => "idle"} />);
    await userEvent.click(screen.getByRole("button", { name: /new session/i }));
    expect(onNew).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/session/SessionList.test.tsx`
Expected: FAIL — `SessionList` does not exist.

- [ ] **Step 7: Write `SessionList` and `AppLayout`**

`packages/web/src/session/SessionList.tsx`:
```tsx
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { LiveWire } from "../ui/LiveWire";
import type { LiveWireState } from "../ui/LiveWire";
import type { SessionMeta } from "../types/server";

export interface SessionListProps {
  sessions: SessionMeta[];
  activeId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  viewWireState: (id: string) => LiveWireState;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export function SessionList({ sessions, activeId, onSelect, onNew, viewWireState }: SessionListProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "var(--sp-3)", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="display" style={{ fontSize: "var(--fs-lg)" }}>Sessions</span>
        <Button variant="primary" onClick={onNew} aria-label="New session">+ New session</Button>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, overflowY: "auto", flex: 1 }}>
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => onSelect(s.id)}
              aria-current={s.id === activeId ? "true" : undefined}
              style={{
                width: "100%", textAlign: "left", minHeight: "var(--tap-min)",
                background: s.id === activeId ? "var(--surface-2)" : "transparent",
                border: "none", borderBottom: "1px solid var(--border)", color: "var(--text)",
                padding: "var(--sp-3)", cursor: "pointer", display: "flex", flexDirection: "column", gap: "var(--sp-1)",
              }}
            >
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--sp-2)" }}>
                <strong>{basename(s.cwd)}</strong>
                <LiveWire state={viewWireState(s.id)} />
              </span>
              <Mono muted>{s.cwd}</Mono>
            </button>
          </li>
        ))}
        {sessions.length === 0 && (
          <li style={{ padding: "var(--sp-4)", color: "var(--text-muted)" }}>No sessions yet. Start one with “New session”.</li>
        )}
      </ul>
    </div>
  );
}
```

`packages/web/src/AppLayout.tsx`:
```tsx
import type { ReactNode } from "react";

export interface AppLayoutProps {
  children: ReactNode;
  sessionList: ReactNode;
  onShowSessions?: () => void;
  sessionsOpen?: boolean;
}

/**
 * Mission-control responsive shell. Desktop (≥768px): left rail + right conversation.
 * Mobile: conversation full-bleed; the session list lives in a bottom sheet toggled by
 * `sessionsOpen`. Layout is CSS-driven (media query in the inline <style>).
 */
export function AppLayout({ children, sessionList, sessionsOpen }: AppLayoutProps) {
  return (
    <div className="rc-shell">
      <aside className="rc-rail" data-open={sessionsOpen ? "true" : "false"}>{sessionList}</aside>
      <main className="rc-main">{children}</main>
      <style>{`
        .rc-shell { height: 100%; display: flex; flex-direction: column; }
        .rc-main { flex: 1; min-height: 0; overflow-y: auto; }
        .rc-rail { background: var(--surface); border-bottom: 1px solid var(--border); max-height: 70vh; overflow-y: auto; }
        /* Mobile: rail is a bottom sheet shown only when open. */
        .rc-rail[data-open="false"] { display: none; }
        @media (min-width: 768px) {
          .rc-shell { flex-direction: row; }
          .rc-rail { width: var(--rail-w); max-height: none; height: 100%; border-bottom: none; border-right: 1px solid var(--border); display: block; }
        }
      `}</style>
    </div>
  );
}
```

- [ ] **Step 8: Run the SessionList test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/session/SessionList.test.tsx`
Expected: PASS (3 cases).

- [ ] **Step 9: Wire `App` to validate the token and render the layout**

Replace the body of `packages/web/src/App.tsx` entirely with (validates the token via `GET /sessions`; on 401 clears the token and shows the login error; otherwise stores sessions and renders the layout with the list — the chat pane and new-session flow are added in Tasks 5–6, so for now the right pane shows a hint):
```tsx
import { useEffect, useMemo, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { loadToken, saveToken, clearToken } from "./auth/token-store";
import { createApiClient, ApiError } from "./api/client";
import { API_BASE_URL } from "./config";
import { useStore } from "./store/store";
import { AppLayout } from "./AppLayout";
import { SessionList } from "./session/SessionList";
import { wireStateForSession } from "./session/status";

type Phase = "login" | "validating" | "ready";

export function App() {
  const [token, setTokenState] = useState<string | undefined>(() => loadToken());
  const [phase, setPhase] = useState<Phase>(token === undefined ? "login" : "validating");
  const [loginError, setLoginError] = useState<string | undefined>();
  const { sessions, setSessions, setToken, activeSessionId, setActive, views } = useStore();

  const api = useMemo(
    () => createApiClient({ baseUrl: API_BASE_URL, getToken: () => (token === "" ? undefined : token) }),
    [token],
  );

  useEffect(() => {
    if (token === undefined) return;
    setToken(token);
    let cancelled = false;
    setPhase("validating");
    api
      .listSessions()
      .then((s) => {
        if (cancelled) return;
        setSessions(s);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          setTokenState(undefined);
          setLoginError("Invalid token (401). Check the access token and try again.");
          setPhase("login");
        } else {
          // network/other error: still enter the app; the list is empty and can be retried.
          setPhase("ready");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, api, setSessions, setToken]);

  if (phase === "login" || token === undefined) {
    return (
      <LoginScreen
        initialError={loginError}
        onAuthenticated={(t) => {
          saveToken(t);
          setLoginError(undefined);
          setTokenState(t);
        }}
      />
    );
  }

  if (phase === "validating") {
    return <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)" }}>Connecting…</div>;
  }

  const list = (
    <SessionList
      sessions={sessions}
      activeId={activeSessionId}
      onSelect={(id) => setActive(id)}
      onNew={() => { /* Task 5 opens the new-session wizard */ }}
      viewWireState={(id) => wireStateForSession(sessions.find((s) => s.id === id) ?? { id, cwd: "", dangerouslySkip: false, status: "running", createdAt: 0 }, views[id])}
    />
  );

  return (
    <AppLayout sessionList={list}>
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)", padding: "var(--sp-5)" }}>
        {activeSessionId ? "Chat view lands in Task 6." : "Select or start a session."}
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 10: Typecheck + commit**

Run: `pnpm -C packages/web typecheck`
Expected: PASS. (If `import.meta.env` errors, confirm `"types": ["vite/client", …]` from Task 1.)
```bash
git add packages/web/src/config.ts packages/web/src/session packages/web/src/AppLayout.tsx packages/web/src/App.tsx
git commit -m "feat(web): session list + status mapping + responsive app layout + token validation"
```

---

### Task 5: New-session wizard + the first-class DIRECTORY PICKER

**Files:**
- Create: `packages/web/src/picker/fuzzy.ts`
- Create: `packages/web/src/picker/fuzzy.test.ts`
- Create: `packages/web/src/picker/DirectoryPicker.tsx`
- Create: `packages/web/src/picker/DirectoryPicker.test.tsx`
- Create: `packages/web/src/picker/recents.ts`
- Create: `packages/web/src/session/NewSessionWizard.tsx`
- Create: `packages/web/src/session/NewSessionWizard.test.tsx`
- Modify: `packages/web/src/App.tsx` (open the wizard from `onNew`; create the session and select it)

**Interfaces:**
- Consumes (Tasks 1–4): `Surface`, `Button`, `Mono`; `ApiClient` (`listDir`, `createSession`); `DirListing`, `DirEntry`, `SessionMeta`; `useStore`.
- Produces:
  - `fuzzy.ts`: `function fuzzyFilter(entries: DirEntry[], query: string): DirEntry[]` — case-insensitive subsequence match on `name`; empty query returns all; preserves input order among matches.
  - `recents.ts`: `function loadRecentDirs(): string[]`, `function pushRecentDir(path: string): void` — `localStorage` key `"roamcode.recents"`, most-recent-first, deduped, capped at 8.
  - `DirectoryPicker` — `props: { listDir: (path?: string) => Promise<DirListing>; recents: string[]; onPick: (path: string) => void; onCancel: () => void }`. A focused full-height sheet: a fuzzy filter input (mono), a breadcrumb of the current `path`, a Recents section, the current directory's entries (git repos badged with branch), large tap-target rows, up/into navigation, and a "Use this directory" action that calls `onPick(currentPath)`. Directories navigate into; the picked path is the directory the user confirms.
  - `NewSessionWizard` — `props: { api: Pick<ApiClient, "listDir" | "createSession">; recents: string[]; onCreated: (session: SessionMeta) => void; onClose: () => void }`. Step 1 = the directory picker; step 2 = effort/model/permission-mode/dangerously-skip; "Start session" calls `api.createSession({ cwd, model, effort, dangerouslySkip })`, pushes the cwd to recents, and calls `onCreated`.

- [ ] **Step 1: Write the fuzzy + recents tests**

`packages/web/src/picker/fuzzy.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fuzzyFilter } from "./fuzzy";
import type { DirEntry } from "../types/server";

function dir(name: string): DirEntry { return { name, path: `/x/${name}`, isDirectory: true, isGitRepo: false }; }
const entries = [dir("packages"), dir("protocol"), dir("docs"), dir("scripts")];

describe("fuzzyFilter", () => {
  it("returns all entries for an empty query", () => {
    expect(fuzzyFilter(entries, "")).toHaveLength(4);
  });
  it("matches a case-insensitive subsequence", () => {
    expect(fuzzyFilter(entries, "doc").map((e) => e.name)).toEqual(["docs"]);
    expect(fuzzyFilter(entries, "PKG".toLowerCase() === "pkg" ? "pcks" : "pcks").map((e) => e.name)).toEqual(["packages"]);
  });
  it("matches subsequence across the name (p..o..o)", () => {
    expect(fuzzyFilter(entries, "poo").map((e) => e.name)).toEqual(["protocol"]);
  });
  it("returns nothing when no entry matches", () => {
    expect(fuzzyFilter(entries, "zzz")).toEqual([]);
  });
});
```

`packages/web/src/picker/recents.test.ts` (create this file too):
```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadRecentDirs, pushRecentDir } from "./recents";

afterEach(() => localStorage.clear());

describe("recents", () => {
  it("stores most-recent-first, deduped", () => {
    pushRecentDir("/a");
    pushRecentDir("/b");
    pushRecentDir("/a");
    expect(loadRecentDirs()).toEqual(["/a", "/b"]);
  });
  it("caps at 8", () => {
    for (let i = 0; i < 12; i++) pushRecentDir(`/p${i}`);
    expect(loadRecentDirs()).toHaveLength(8);
    expect(loadRecentDirs()[0]).toBe("/p11");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C packages/web exec vitest run src/picker/fuzzy.test.ts src/picker/recents.test.ts`
Expected: FAIL — `fuzzy` / `recents` do not exist.

- [ ] **Step 3: Write `fuzzy.ts` and `recents.ts`**

`packages/web/src/picker/fuzzy.ts`:
```ts
import type { DirEntry } from "../types/server";

/** Case-insensitive subsequence match on entry.name. Empty query → all (original order). */
export function fuzzyFilter(entries: DirEntry[], query: string): DirEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => isSubsequence(q, e.name.toLowerCase()));
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}
```

`packages/web/src/picker/recents.ts`:
```ts
const KEY = "roamcode.recents";
const CAP = 8;

export function loadRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

export function pushRecentDir(path: string): void {
  const current = loadRecentDirs().filter((p) => p !== path);
  const next = [path, ...current].slice(0, CAP);
  localStorage.setItem(KEY, JSON.stringify(next));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/web exec vitest run src/picker/fuzzy.test.ts src/picker/recents.test.ts`
Expected: PASS (fuzzy 4 + recents 2).

- [ ] **Step 5: Write the DirectoryPicker test**

`packages/web/src/picker/DirectoryPicker.test.tsx`:
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DirectoryPicker } from "./DirectoryPicker";
import type { DirListing } from "../types/server";

const home: DirListing = {
  path: "/home/u",
  parent: "/home",
  entries: [
    { name: "roamcode", path: "/home/u/roamcode", isDirectory: true, isGitRepo: true, gitBranch: "main" },
    { name: "notes", path: "/home/u/notes", isDirectory: true, isGitRepo: false },
  ],
};
const repo: DirListing = { path: "/home/u/roamcode", parent: "/home/u", entries: [] };

function listDir(path?: string): Promise<DirListing> {
  if (path === "/home/u/roamcode") return Promise.resolve(repo);
  return Promise.resolve(home);
}

describe("DirectoryPicker", () => {
  it("lists entries, badges git repos with a branch, and filters fuzzily", async () => {
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("roamcode")).toBeInTheDocument());
    expect(screen.getByText(/git:main/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/filter directories/i), "notes");
    await waitFor(() => expect(screen.queryByText("roamcode")).not.toBeInTheDocument());
    expect(screen.getByText("notes")).toBeInTheDocument();
  });

  it("navigates into a directory and picks the confirmed path", async () => {
    const onPick = vi.fn();
    render(<DirectoryPicker listDir={listDir} recents={[]} onPick={onPick} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByText("roamcode"));
    await userEvent.click(screen.getByText("roamcode"));
    await waitFor(() => expect(screen.getByText("/home/u/roamcode")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /use this directory/i }));
    expect(onPick).toHaveBeenCalledWith("/home/u/roamcode");
  });

  it("shows recents and picks one directly", async () => {
    const onPick = vi.fn();
    render(<DirectoryPicker listDir={listDir} recents={["/home/u/pinned-proj"]} onPick={onPick} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByText("/home/u/pinned-proj"));
    expect(onPick).toHaveBeenCalledWith("/home/u/pinned-proj");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/picker/DirectoryPicker.test.tsx`
Expected: FAIL — `DirectoryPicker` does not exist.

- [ ] **Step 7: Write `DirectoryPicker`**

`packages/web/src/picker/DirectoryPicker.tsx`:
```tsx
import { useEffect, useState } from "react";
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { fuzzyFilter } from "./fuzzy";
import type { DirListing } from "../types/server";

export interface DirectoryPickerProps {
  listDir: (path?: string) => Promise<DirListing>;
  recents: string[];
  onPick: (path: string) => void;
  onCancel: () => void;
}

export function DirectoryPicker({ listDir, recents, onPick, onCancel }: DirectoryPickerProps) {
  const [listing, setListing] = useState<DirListing | undefined>();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | undefined>();

  function navigate(path?: string) {
    setError(undefined);
    listDir(path)
      .then(setListing)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "failed to list directory"));
  }

  useEffect(() => {
    navigate(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entries = listing ? fuzzyFilter(listing.entries.filter((e) => e.isDirectory), filter) : [];

  return (
    <div role="dialog" aria-label="Pick a directory" style={{ position: "fixed", inset: 0, background: "var(--bg)", display: "flex", flexDirection: "column", zIndex: 50 }}>
      <div style={{ padding: "var(--sp-4)", borderBottom: "1px solid var(--border)", display: "grid", gap: "var(--sp-3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong className="display" style={{ fontSize: "var(--fs-lg)" }}>Pick a directory</strong>
          <Button variant="ghost" onClick={onCancel} aria-label="Cancel">Cancel</Button>
        </div>
        <input
          aria-label="Filter directories"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter directories…"
          style={{ minHeight: "var(--tap-min)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text)", padding: "0 var(--sp-3)", fontFamily: "var(--font-mono)" }}
        />
        {listing && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
            {listing.parent !== undefined && (
              <Button variant="ghost" onClick={() => navigate(listing.parent)} aria-label="Up one directory">↑ Up</Button>
            )}
            <Mono muted>{listing.path}</Mono>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "var(--sp-4)", display: "grid", gap: "var(--sp-4)" }}>
        {error && <div role="alert" style={{ color: "var(--err)" }}>{error}</div>}
        {recents.length > 0 && (
          <section>
            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1, marginBottom: "var(--sp-2)" }}>Recents</div>
            {recents.map((p) => (
              <button key={p} onClick={() => onPick(p)} style={rowStyle}>
                <Mono>{p}</Mono>
              </button>
            ))}
          </section>
        )}
        <section>
          <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1, marginBottom: "var(--sp-2)" }}>Browse</div>
          {entries.map((e) => (
            <button key={e.path} onClick={() => navigate(e.path)} style={rowStyle}>
              <Mono>{e.name}/</Mono>
              {e.isGitRepo && <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>git:{e.gitBranch}</span>}
            </button>
          ))}
          {listing && entries.length === 0 && <div style={{ color: "var(--text-muted)" }}>No subdirectories.</div>}
        </section>
      </div>

      <div style={{ padding: "var(--sp-4)", borderTop: "1px solid var(--border)" }}>
        <Button variant="primary" onClick={() => listing && onPick(listing.path)} aria-label="Use this directory">
          Use this directory
        </Button>
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  width: "100%", textAlign: "left", minHeight: "var(--tap-min)", display: "flex",
  justifyContent: "space-between", alignItems: "center", gap: "var(--sp-2)",
  background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
  color: "var(--text)", padding: "0 var(--sp-2)", cursor: "pointer",
};
```

- [ ] **Step 8: Run the DirectoryPicker test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/picker/DirectoryPicker.test.tsx`
Expected: PASS (3 cases). If filtering doesn't hide `roamcode`, confirm `fuzzyFilter` runs on `listing.entries` after the `isDirectory` filter and re-renders on `filter` change.

- [ ] **Step 9: Write the NewSessionWizard test**

`packages/web/src/session/NewSessionWizard.test.tsx`:
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewSessionWizard } from "./NewSessionWizard";
import type { DirListing, SessionMeta } from "../types/server";

const listing: DirListing = {
  path: "/home/u",
  entries: [{ name: "proj", path: "/home/u/proj", isDirectory: true, isGitRepo: true, gitBranch: "main" }],
};

describe("NewSessionWizard", () => {
  it("picks a directory then creates a session with the chosen settings", async () => {
    const createSession = vi.fn(
      async (): Promise<SessionMeta> => ({ id: "new-1", cwd: "/home/u", dangerouslySkip: false, status: "running", createdAt: 1 }),
    );
    const onCreated = vi.fn();
    render(
      <NewSessionWizard
        api={{ listDir: () => Promise.resolve(listing), createSession }}
        recents={[]}
        onCreated={onCreated}
        onClose={vi.fn()}
      />,
    );
    // Step 1: confirm the current directory.
    await waitFor(() => screen.getByRole("button", { name: /use this directory/i }));
    await userEvent.click(screen.getByRole("button", { name: /use this directory/i }));
    // Step 2: settings → start.
    await waitFor(() => screen.getByRole("button", { name: /start session/i }));
    await userEvent.click(screen.getByRole("button", { name: /start session/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(createSession.mock.calls[0]![0]).toMatchObject({ cwd: "/home/u" });
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new-1" }));
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/session/NewSessionWizard.test.tsx`
Expected: FAIL — `NewSessionWizard` does not exist.

- [ ] **Step 11: Write `NewSessionWizard`**

`packages/web/src/session/NewSessionWizard.tsx`:
```tsx
import { useState } from "react";
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { DirectoryPicker } from "../picker/DirectoryPicker";
import { pushRecentDir } from "../picker/recents";
import type { ApiClient } from "../api/client";
import type { SessionMeta } from "../types/server";

export interface NewSessionWizardProps {
  api: Pick<ApiClient, "listDir" | "createSession">;
  recents: string[];
  onCreated: (session: SessionMeta) => void;
  onClose: () => void;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;

export function NewSessionWizard({ api, recents, onCreated, onClose }: NewSessionWizardProps) {
  const [cwd, setCwd] = useState<string | undefined>();
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>("medium");
  const [model, setModel] = useState("");
  const [dangerouslySkip, setDangerouslySkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!cwd) {
    return (
      <DirectoryPicker
        listDir={api.listDir}
        recents={recents}
        onPick={(path) => setCwd(path)}
        onCancel={onClose}
      />
    );
  }

  async function start() {
    if (!cwd) return;
    setBusy(true);
    setError(undefined);
    try {
      const session = await api.createSession({ cwd, effort, model: model || undefined, dangerouslySkip });
      pushRecentDir(cwd);
      onCreated(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start session");
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-label="New session settings" style={{ position: "fixed", inset: 0, background: "var(--bg)", display: "grid", placeItems: "center", padding: "var(--sp-5)", zIndex: 50 }}>
      <Surface level={1} as="section">
        <div style={{ padding: "var(--sp-5)", display: "grid", gap: "var(--sp-4)", width: "min(92vw, 460px)" }}>
          <strong className="display" style={{ fontSize: "var(--fs-lg)" }}>Start a session</strong>
          <div>Directory: <Mono>{cwd}</Mono> <Button variant="ghost" onClick={() => setCwd(undefined)} aria-label="Change directory">Change</Button></div>
          <label style={{ display: "grid", gap: "var(--sp-2)" }}>
            <span style={{ fontSize: "var(--fs-sm)" }}>Effort</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value as (typeof EFFORTS)[number])} style={selectStyle}>
              {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: "var(--sp-2)" }}>
            <span style={{ fontSize: "var(--fs-sm)" }}>Model (optional)</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" style={{ ...selectStyle, fontFamily: "var(--font-mono)" }} />
          </label>
          <label style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", color: dangerouslySkip ? "var(--err)" : "var(--text)" }}>
            <input type="checkbox" checked={dangerouslySkip} onChange={(e) => setDangerouslySkip(e.target.checked)} />
            <span>Dangerously skip permissions (RCE risk)</span>
          </label>
          {error && <div role="alert" style={{ color: "var(--err)" }}>{error}</div>}
          <div style={{ display: "flex", gap: "var(--sp-3)" }}>
            <Button variant="primary" disabled={busy} onClick={start} aria-label="Start session">{busy ? "Starting…" : "Start session"}</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </Surface>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  minHeight: "var(--tap-min)", background: "var(--surface)", border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)", color: "var(--text)", padding: "0 var(--sp-3)", font: "inherit",
};
```
(Note: `PERMISSION_MODES` is exported-ready for Task 10's settings panel; the wizard keeps v1 minimal — effort/model/dangerously-skip — and the per-session permission-mode lives in Settings. It is referenced here only to keep the constant in one place; eslint may flag it unused — if so, prefix with `// eslint-disable-next-line @typescript-eslint/no-unused-vars` on its declaration, or move it to Task 10. Simplest: delete the `PERMISSION_MODES` line from this file and re-add it in Task 10.)

- [ ] **Step 12: Run the wizard test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/session/NewSessionWizard.test.tsx`
Expected: PASS. If the test cannot find "Start session", confirm the wizard advances past the picker once `onPick` sets `cwd`.

- [ ] **Step 13: Open the wizard from `App`**

In `packages/web/src/App.tsx`, add wizard state and wire `onNew`. Add the imports near the top (after the existing imports):
```tsx
import { NewSessionWizard } from "./session/NewSessionWizard";
import { loadRecentDirs } from "./picker/recents";
```
Add a state hook alongside the others inside `App` (after the `const { sessions, … } = useStore();` line):
```tsx
  const [wizardOpen, setWizardOpen] = useState(false);
```
Change the `SessionList`'s `onNew` from the empty handler to:
```tsx
      onNew={() => setWizardOpen(true)}
```
Finally, render the wizard. Replace the `return (` block at the end of the `ready` path:
```tsx
  return (
    <AppLayout sessionList={list}>
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)", padding: "var(--sp-5)" }}>
        {activeSessionId ? "Chat view lands in Task 6." : "Select or start a session."}
      </div>
    </AppLayout>
  );
```
with:
```tsx
  return (
    <>
      <AppLayout sessionList={list}>
        <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)", padding: "var(--sp-5)" }}>
          {activeSessionId ? "Chat view lands in Task 6." : "Select or start a session."}
        </div>
      </AppLayout>
      {wizardOpen && (
        <NewSessionWizard
          api={api}
          recents={loadRecentDirs()}
          onClose={() => setWizardOpen(false)}
          onCreated={(session) => {
            setSessions([...sessions, session]);
            setActive(session.id);
            setWizardOpen(false);
          }}
        />
      )}
    </>
  );
```

- [ ] **Step 14: Run the picker/wizard suite + typecheck + commit**

Run: `pnpm -C packages/web exec vitest run src/picker src/session`
Expected: PASS. Then `pnpm -C packages/web typecheck` → PASS (if `PERMISSION_MODES` is flagged unused, apply the note in Step 11 — simplest is to delete that line here).
```bash
git add packages/web/src/picker packages/web/src/session/NewSessionWizard.tsx packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/App.tsx
git commit -m "feat(web): first-class directory picker (fuzzy/git/breadcrumb/recents) + new-session wizard"
```

---

### Task 6: Chat view — streaming render, tool activity, results, the live-wire header

**Files:**
- Create: `packages/web/src/chat/CodeBlock.tsx`
- Create: `packages/web/src/chat/Markdown.tsx`
- Create: `packages/web/src/chat/MessageList.tsx`
- Create: `packages/web/src/chat/MessageList.test.tsx`
- Create: `packages/web/src/chat/ChatHeader.tsx`
- Create: `packages/web/src/chat/ChatView.tsx`
- Create: `packages/web/src/chat/ChatView.test.tsx`
- Create: `packages/web/src/session/use-session-socket.ts`
- Modify: `packages/web/src/App.tsx` (render `ChatView` for the active session)

**Interfaces:**
- Consumes (Tasks 1–5): `Surface`, `Mono`, `LiveWire`; `SessionView`, `TurnItem`; `useStore`; `createSessionSocket`, `wsUrl`; `ApiClient`; `SessionMeta`; `API_BASE_URL`.
- Produces:
  - `Markdown` — `props: { children: string }` — renders markdown via `react-markdown`, routing fenced code through `CodeBlock`. Inline code is mono.
  - `CodeBlock` — `props: { code: string; language?: string }` — a mono code block (syntax highlighting via `shiki` is applied lazily; the fallback is a plain mono `<pre>` so a test/SSR path never blocks on async highlighting).
  - `MessageList` — `props: { view: SessionView }` — renders, in order: each `TurnItem` (assistant-text → Markdown; tool-use → a cyan "Tool" row with mono name + collapsed input; tool-result → a muted mono result; user → the user's text/image blocks; result → a success/error summary with mono cost), then the in-flight `liveText` (streaming, faded-in) and `thinkingText` (muted) if present. Tool/path/id text is mono.
  - `ChatHeader` — `props: { session: SessionMeta; wireState: LiveWireState; onOpenSettings?: () => void }` — the session header carrying the `LiveWire` (the alive remote-link signal), mono cwd + git branch hint, and a settings affordance.
  - `ChatView` — `props: { session: SessionMeta; api: ApiClient; token: string | undefined }` — loads `GET /sessions/:id` history into the store on mount (replaying each `ServerFrame` through `applyFrame`), opens the reconnecting socket, renders `ChatHeader` + `MessageList` + a placeholder composer slot (the real composer is Task 8; here it renders `children`-free). The pending-permission UI is added in Task 7 (this task leaves a slot).
  - `use-session-socket.ts`: `function useSessionSocket(session: SessionMeta, token: string | undefined): { send: (f: OutboundFrame) => void; status: SocketStatus }` — a hook that opens a `SessionSocket` for the session (URL from `wsUrl(API_BASE_URL, id, { token, since })`), feeds frames to `useStore().applyFrame`, tracks status, and tears down on unmount or id change. `getSince` reads the store view's `lastSeq`.

- [ ] **Step 1: Write the MessageList test**

`packages/web/src/chat/MessageList.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList";
import type { SessionView } from "../store/frame-reducer";

function viewWith(partial: Partial<SessionView>): SessionView {
  return { liveText: "", thinkingText: "", turns: [], diagnostics: [], wireState: "idle", lastSeq: 0, ...partial };
}

describe("MessageList", () => {
  it("renders assistant text, a tool-use row, and a result summary", () => {
    render(
      <MessageList
        view={viewWith({
          turns: [
            { kind: "assistant-text", text: "Creating the file." },
            { kind: "tool-use", id: "tu1", name: "Write", input: { file_path: "/a.txt" } },
            { kind: "result", result: "Done", isError: false, totalCostUsd: 0.0123 },
          ],
        })}
      />,
    );
    expect(screen.getByText(/creating the file/i)).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText(/done/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.0123/)).toBeInTheDocument();
  });

  it("renders in-flight streaming liveText", () => {
    render(<MessageList view={viewWith({ liveText: "streaming tokens…", wireState: "streaming" })} />);
    expect(screen.getByText(/streaming tokens/i)).toBeInTheDocument();
  });

  it("renders a tool-result", () => {
    render(<MessageList view={viewWith({ turns: [{ kind: "tool-result", toolUseId: "tu1", content: "file written" }] })} />);
    expect(screen.getByText(/file written/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/chat/MessageList.test.tsx`
Expected: FAIL — `MessageList` does not exist.

- [ ] **Step 3: Write `CodeBlock`, `Markdown`, `MessageList`**

`packages/web/src/chat/CodeBlock.tsx`:
```tsx
/**
 * Mono code block. Shiki highlighting is intentionally deferred to keep render synchronous and
 * test-friendly; a plain <pre> in JetBrains Mono is the always-available baseline. (A later
 * enhancement can swap in shiki's async highlight without changing this component's props.)
 */
export interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  return (
    <pre
      data-language={language}
      style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--sp-3)", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)", margin: 0 }}
    >
      <code style={{ fontFamily: "var(--font-mono)" }}>{code}</code>
    </pre>
  );
}
```

`packages/web/src/chat/Markdown.tsx`:
```tsx
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock";

const components: Components = {
  code({ className, children, ...props }) {
    const text = String(children).replace(/\n$/, "");
    const match = /language-(\w+)/.exec(className ?? "");
    // Fenced block (has a language class or contains a newline) → CodeBlock; else inline mono.
    if (match || text.includes("\n")) {
      return <CodeBlock code={text} language={match?.[1]} />;
    }
    return (
      <code {...props} style={{ fontFamily: "var(--font-mono)", background: "var(--surface-2)", padding: "0 4px", borderRadius: 4 }}>
        {children}
      </code>
    );
  },
};

export interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps) {
  return <ReactMarkdown components={components}>{children}</ReactMarkdown>;
}
```

`packages/web/src/chat/MessageList.tsx`:
```tsx
import { Mono } from "../ui/Mono";
import { Markdown } from "./Markdown";
import type { SessionView, TurnItem } from "../store/frame-reducer";
import type { ContentBlock } from "../types/server";

function Turn({ item }: { item: TurnItem }) {
  switch (item.kind) {
    case "assistant-text":
      return <div style={{ color: "var(--text)" }}><Markdown>{item.text}</Markdown></div>;
    case "tool-use":
      return (
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "baseline", color: "var(--cyan)", fontSize: "var(--fs-sm)" }}>
          <span style={{ fontFamily: "var(--font-display)" }}>Tool</span>
          <Mono>{item.name}</Mono>
          <Mono muted>{summarizeInput(item.input)}</Mono>
        </div>
      );
    case "tool-result":
      return <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}><Mono muted>{stringify(item.content)}</Mono></div>;
    case "user":
      return <div style={{ color: "var(--text)", borderLeft: "2px solid var(--border)", paddingLeft: "var(--sp-3)" }}>{renderBlocks(item.blocks)}</div>;
    case "result":
      return (
        <div style={{ color: item.isError ? "var(--err)" : "var(--ok)", fontSize: "var(--fs-sm)", borderTop: "1px solid var(--border)", paddingTop: "var(--sp-3)" }}>
          {item.isError ? "Error" : "Done"}{item.result ? ` — ${item.result}` : ""}
          {item.totalCostUsd !== undefined && <> · <Mono muted>${item.totalCostUsd.toFixed(4)}</Mono></>}
        </div>
      );
  }
}

export interface MessageListProps {
  view: SessionView;
}

export function MessageList({ view }: MessageListProps) {
  return (
    <div style={{ display: "grid", gap: "var(--sp-4)", padding: "var(--sp-4)" }}>
      {view.turns.map((item, i) => <Turn key={i} item={item} />)}
      {view.thinkingText && (
        <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{view.thinkingText}</div>
      )}
      {view.liveText && (
        <div style={{ color: "var(--text)", animation: "rc-fade-in 0.2s ease-out" }}>
          <Markdown>{view.liveText}</Markdown>
          <style>{`@keyframes rc-fade-in { from { opacity: 0.4; } to { opacity: 1; } }`}</style>
        </div>
      )}
    </div>
  );
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.file_path === "string") return obj.file_path;
    if (typeof obj.command === "string") return obj.command;
    if (typeof obj.path === "string") return obj.path;
  }
  return "";
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function renderBlocks(blocks: ContentBlock[]) {
  return blocks.map((b, i) =>
    b.type === "text" ? <div key={i}>{b.text}</div> : <div key={i} style={{ color: "var(--text-muted)" }}>[image]</div>,
  );
}
```

- [ ] **Step 4: Run the MessageList test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/chat/MessageList.test.tsx`
Expected: PASS (3 cases). If `react-markdown` errors under jsdom, confirm it is installed (Task 1 deps) and that `Markdown` receives a string.

- [ ] **Step 5: Write the `useSessionSocket` hook and `ChatHeader`**

`packages/web/src/session/use-session-socket.ts`:
```ts
import { useEffect, useRef, useState } from "react";
import { createSessionSocket } from "../ws/session-socket";
import type { SessionSocket, SocketStatus } from "../ws/session-socket";
import { wsUrl } from "../api/client";
import { API_BASE_URL } from "../config";
import { useStore } from "../store/store";
import type { OutboundFrame, SessionMeta } from "../types/server";

export function useSessionSocket(
  session: SessionMeta,
  token: string | undefined,
): { send: (f: OutboundFrame) => void; status: SocketStatus } {
  const applyFrame = useStore((s) => s.applyFrame);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const socketRef = useRef<SessionSocket | undefined>(undefined);

  useEffect(() => {
    const url = wsUrl(API_BASE_URL, session.id, { token: token || undefined });
    const socket = createSessionSocket({
      url,
      onFrame: (frame) => applyFrame(session.id, frame),
      onStatus: setStatus,
      // Reconnect delta: resume after the last applied seq for THIS session.
      getSince: () => {
        const last = useStore.getState().views[session.id]?.lastSeq ?? 0;
        return last > 0 ? last : undefined;
      },
    });
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = undefined;
    };
  }, [session.id, token, applyFrame]);

  return {
    send: (f) => socketRef.current?.send(f),
    status,
  };
}
```

`packages/web/src/chat/ChatHeader.tsx`:
```tsx
import { Mono } from "../ui/Mono";
import { Button } from "../ui/Button";
import { LiveWire } from "../ui/LiveWire";
import type { LiveWireState } from "../ui/LiveWire";
import type { SessionMeta } from "../types/server";

export interface ChatHeaderProps {
  session: SessionMeta;
  wireState: LiveWireState;
  onOpenSettings?: () => void;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export function ChatHeader({ session, wireState, onOpenSettings }: ChatHeaderProps) {
  return (
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "var(--sp-4)", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0 }}>
        <strong className="display">{basename(session.cwd)}</strong>
        <Mono muted>{session.cwd}</Mono>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <LiveWire state={wireState} aria-label={`Session ${basename(session.cwd)} — ${wireState}`} />
        {onOpenSettings && <Button variant="ghost" onClick={onOpenSettings} aria-label="Session settings">Settings</Button>}
      </div>
    </header>
  );
}
```

- [ ] **Step 6: Write the ChatView test**

`packages/web/src/chat/ChatView.test.tsx` (the real WS is not opened in jsdom — we stub `getSession` to return history and assert it renders; the socket hook's WebSocket is the global, which jsdom provides as a constructor that never connects, so no frames arrive and teardown is clean):
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { useStore } from "../store/store";
import type { ApiClient } from "../api/client";
import type { ServerFrame, SessionMeta } from "../types/server";

const session: SessionMeta = { id: "s1", cwd: "/home/u/proj", dangerouslySkip: false, status: "running", createdAt: 1 };

const history: ServerFrame[] = [
  { seq: 1, kind: "event", payload: { type: "assistant", message: { content: [{ type: "text", text: "Hello from history" }] } } },
  { seq: 2, kind: "result", payload: { type: "result", result: "All set", permissionDenials: [] } },
];

function apiStub(): ApiClient {
  return {
    listSessions: vi.fn(),
    getSession: vi.fn(async () => ({ session, history })),
    createSession: vi.fn(),
    stopSession: vi.fn(),
    listDir: vi.fn(),
    uploadFile: vi.fn(),
    downloadUrl: () => "",
  } as unknown as ApiClient;
}

afterEach(() => {
  useStore.setState({ views: {} });
});

describe("ChatView", () => {
  it("loads history into the store and renders it", async () => {
    render(<ChatView session={session} api={apiStub()} token="t" />);
    await waitFor(() => expect(screen.getByText(/hello from history/i)).toBeInTheDocument());
    expect(screen.getByText(/all set/i)).toBeInTheDocument();
  });

  it("shows the session cwd in the header", async () => {
    render(<ChatView session={session} api={apiStub()} token="t" />);
    expect(screen.getByText("/home/u/proj")).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/chat/ChatView.test.tsx`
Expected: FAIL — `ChatView` does not exist.

- [ ] **Step 8: Write `ChatView`**

`packages/web/src/chat/ChatView.tsx`:
```tsx
import { useEffect } from "react";
import { ChatHeader } from "./ChatHeader";
import { MessageList } from "./MessageList";
import { useStore } from "../store/store";
import { useSessionSocket } from "../session/use-session-socket";
import { wireStateForSession } from "../session/status";
import type { ApiClient } from "../api/client";
import type { SessionMeta } from "../types/server";

export interface ChatViewProps {
  session: SessionMeta;
  api: ApiClient;
  token: string | undefined;
}

export function ChatView({ session, api, token }: ChatViewProps) {
  const applyFrame = useStore((s) => s.applyFrame);
  const resetSession = useStore((s) => s.resetSession);
  const view = useStore((s) => s.views[session.id]);

  // Open the live socket (frames flow into the store via the hook).
  useSessionSocket(session, token);

  // Load REST history once per session id, replaying frames through the same reducer.
  useEffect(() => {
    let cancelled = false;
    resetSession(session.id);
    api
      .getSession(session.id)
      .then(({ history }) => {
        if (cancelled) return;
        for (const frame of history) applyFrame(session.id, frame);
      })
      .catch(() => {
        // history load failure is non-fatal; live frames still arrive over WS
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, api, applyFrame, resetSession]);

  const wireState = wireStateForSession(session, view);
  const safeView = view ?? { liveText: "", thinkingText: "", turns: [], diagnostics: [], wireState: "idle", lastSeq: 0 };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ChatHeader session={session} wireState={wireState} />
      <div style={{ flex: 1, overflowY: "auto" }}>
        <MessageList view={safeView} />
        {/* Task 7 renders the pending-permission prompt here; Task 8 adds the composer below. */}
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Run the ChatView test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/chat/ChatView.test.tsx`
Expected: PASS (2 cases). If history never renders, confirm `getSession` resolves with `{ history }` and `applyFrame` is called per frame. If the test hangs, confirm the socket hook's cleanup calls `socket.close()` (jsdom's `WebSocket` won't connect to a fake host, but the object is created and closed without error).

- [ ] **Step 10: Render `ChatView` for the active session in `App`**

In `packages/web/src/App.tsx`, add the import (near the other imports):
```tsx
import { ChatView } from "./chat/ChatView";
```
Replace the placeholder right-pane in the `ready` return:
```tsx
        <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)", padding: "var(--sp-5)" }}>
          {activeSessionId ? "Chat view lands in Task 6." : "Select or start a session."}
        </div>
```
with (render the chat for the active session, else a hint):
```tsx
        {activeSessionId ? (
          (() => {
            const active = sessions.find((s) => s.id === activeSessionId);
            return active ? (
              <ChatView session={active} api={api} token={token} />
            ) : (
              <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)" }}>Session not found.</div>
            );
          })()
        ) : (
          <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-muted)", padding: "var(--sp-5)" }}>Select or start a session.</div>
        )}
```

- [ ] **Step 11: Run the chat suite + typecheck + commit**

Run: `pnpm -C packages/web exec vitest run src/chat`
Expected: PASS. Then `pnpm -C packages/web typecheck` → PASS.
```bash
git add packages/web/src/chat packages/web/src/session/use-session-socket.ts packages/web/src/App.tsx
git commit -m "feat(web): chat view — streaming/tool/result render, markdown+code, live-wire header"
```

---

### Task 7: Inline permission prompts — allow/deny tool gate (the iris "awaiting you" moment)

> **Scope correction (read first — the obvious "answer the question" approach is semantically WRONG).** The Plan 3 server's `permission` frame and the WS answer `{ type:"permission", requestId, decision:"allow"|"deny", reason? }` are a **tool-use allow/deny gate** (the captured `PreToolUse` hook / `can_use_tool` path — see `docs/protocol-notes.md` §5). The `reason` field is **NOT** delivered to the model as a chosen answer — it is a human-readable note attached to the allow/deny decision. So this task builds **only** the verified surface: render and answer permission prompts (Allow / Deny) for tool use, including when `toolName === "AskUserQuestion"` (shown as a clearly-labeled permission with its tool input, allow/deny only). It deliberately does **NOT** build a multi-option "answer" UI that stuffs the selected option into `reason` — that would silently fail to answer the question. **Full AskUserQuestion answering** (the model asking the user to pick an option, which in headless surfaces as an `elicitation`/`request_user_dialog` control_request not captured by the Plan-2 spike nor relayed by the Plan-3 WS) is deferred to Plan 5 — see "Out of scope → Plan 5" at the end of this plan.

**Files:**
- Create: `packages/web/src/chat/PermissionPrompt.tsx`
- Create: `packages/web/src/chat/PermissionPrompt.test.tsx`
- Modify: `packages/web/src/chat/ChatView.tsx` (render the pending permission; send the allow/deny answer over WS)

**Interfaces:**
- Consumes (Tasks 1–6): `Surface`, `Button`, `Mono`; `PermissionPayload`; `OutboundFrame`; `SessionView`; the `send` from `useSessionSocket`.
- Produces:
  - `PermissionPrompt` — `props: { permission: PermissionPayload; onAnswer: (decision: "allow" | "deny") => void }`. The iris-edged "Awaiting you" card: shows the tool name (mono), a summary of the input (mono path/command), and large Allow (primary) / Deny (ghost) tap targets. `role="region"` + `aria-label="Permission request"` so it is announced; the iris color is paired with the "Awaiting you" text (a11y). When `permission.toolName === "AskUserQuestion"` it shows the question text from `toolInput` for context but still offers only Allow/Deny (allowing lets the agent proceed to ask; it is not the answer itself).

- [ ] **Step 1: Write the PermissionPrompt test**

`packages/web/src/chat/PermissionPrompt.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermissionPrompt } from "./PermissionPrompt";
import type { PermissionPayload } from "../types/server";

const perm: PermissionPayload = { requestId: "r1", kind: "hook_callback", toolName: "Write", toolInput: { file_path: "/tmp/a.txt" } };

describe("PermissionPrompt", () => {
  it("shows the tool name + input and announces an awaiting region", () => {
    render(<PermissionPrompt permission={perm} onAnswer={vi.fn()} />);
    expect(screen.getByRole("region", { name: /permission request/i })).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("/tmp/a.txt")).toBeInTheDocument();
    expect(screen.getByText(/awaiting you/i)).toBeInTheDocument();
  });

  it("answers allow and deny (decision only — no reason payload)", async () => {
    const onAnswer = vi.fn();
    render(<PermissionPrompt permission={perm} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(onAnswer).toHaveBeenCalledWith("allow");
    await userEvent.click(screen.getByRole("button", { name: /^deny$/i }));
    expect(onAnswer).toHaveBeenCalledWith("deny");
  });

  it("for AskUserQuestion, shows the question text but still only allow/deny", () => {
    const ask: PermissionPayload = {
      requestId: "r2",
      kind: "hook_callback",
      toolName: "AskUserQuestion",
      toolInput: { question: "Which database should I use?" },
    };
    render(<PermissionPrompt permission={ask} onAnswer={vi.fn()} />);
    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument();
    expect(screen.getByText(/which database should i use/i)).toBeInTheDocument();
    // It is a permission gate, not a multi-option answerer: only Allow + Deny.
    expect(screen.getByRole("button", { name: /^allow$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/chat/PermissionPrompt.test.tsx`
Expected: FAIL — `PermissionPrompt` does not exist.

- [ ] **Step 3: Write `PermissionPrompt`**

`packages/web/src/chat/PermissionPrompt.tsx`:
```tsx
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import type { PermissionPayload } from "../types/server";

export interface PermissionPromptProps {
  permission: PermissionPayload;
  onAnswer: (decision: "allow" | "deny") => void;
}

/** Pull a short human-readable detail from the tool input for display (path/command/question). */
function summarizeInput(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["file_path", "command", "path", "url", "question"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return undefined;
}

export function PermissionPrompt({ permission, onAnswer }: PermissionPromptProps) {
  const detail = summarizeInput(permission.toolInput);
  return (
    <Surface level={2} as="article">
      <div role="region" aria-label="Permission request" style={{ borderLeft: "3px solid var(--iris)", padding: "var(--sp-4)", display: "grid", gap: "var(--sp-3)" }}>
        <div style={{ color: "var(--iris)", fontFamily: "var(--font-display)" }}>Awaiting you — permission</div>
        <div>
          Allow <Mono>{permission.toolName ?? "tool"}</Mono>
          {detail && <> — <Mono muted>{detail}</Mono></>}?
        </div>
        <div style={{ display: "flex", gap: "var(--sp-3)" }}>
          <Button variant="primary" onClick={() => onAnswer("allow")} aria-label="Allow">Allow</Button>
          <Button variant="ghost" onClick={() => onAnswer("deny")} aria-label="Deny">Deny</Button>
        </div>
      </div>
    </Surface>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/chat/PermissionPrompt.test.tsx`
Expected: PASS (3 cases).

- [ ] **Step 5: Render the pending permission in `ChatView` and answer over WS**

In `packages/web/src/chat/ChatView.tsx`, capture the socket's `send` and render the prompt. Change:
```tsx
  // Open the live socket (frames flow into the store via the hook).
  useSessionSocket(session, token);
```
to:
```tsx
  // Open the live socket (frames flow into the store via the hook).
  const { send } = useSessionSocket(session, token);
```
Add the import near the top (after the existing imports):
```tsx
import { PermissionPrompt } from "./PermissionPrompt";
```
Then, inside the scrolling area, render the pending permission. Replace:
```tsx
      <div style={{ flex: 1, overflowY: "auto" }}>
        <MessageList view={safeView} />
        {/* Task 7 renders the pending-permission prompt here; Task 8 adds the composer below. */}
      </div>
```
with (an allow/deny tool gate — NO reason payload; `AskUserQuestion` is just another tool permission here):
```tsx
      <div style={{ flex: 1, overflowY: "auto" }}>
        <MessageList view={safeView} />
        {safeView.pendingPermission && (
          <div style={{ padding: "var(--sp-4)" }}>
            <PermissionPrompt
              permission={safeView.pendingPermission}
              onAnswer={(decision) =>
                send({ type: "permission", requestId: safeView.pendingPermission!.requestId, decision })
              }
            />
          </div>
        )}
        {/* Task 8 adds the composer below. */}
      </div>
```

- [ ] **Step 6: Run the chat suite + typecheck + commit**

Run: `pnpm -C packages/web exec vitest run src/chat`
Expected: PASS (MessageList + ChatView + PermissionPrompt all green). Then `pnpm -C packages/web typecheck` → PASS.
```bash
git add packages/web/src/chat/PermissionPrompt.tsx packages/web/src/chat/PermissionPrompt.test.tsx packages/web/src/chat/ChatView.tsx
git commit -m "feat(web): inline permission prompt — allow/deny tool gate (iris awaiting-you) → WS"
```

---

### Task 8: Composer — text + image (camera/gallery) + file upload + slash commands

**Files:**
- Create: `packages/web/src/chat/image-util.ts`
- Create: `packages/web/src/chat/image-util.test.ts`
- Create: `packages/web/src/chat/slash.ts`
- Create: `packages/web/src/chat/slash.test.ts`
- Create: `packages/web/src/chat/Composer.tsx`
- Create: `packages/web/src/chat/Composer.test.tsx`
- Modify: `packages/web/src/chat/ChatView.tsx` (render the `Composer`; send user messages over WS; upload files via the api)

**Interfaces:**
- Consumes (Tasks 1–7): `Button`, `Mono`; `OutboundFrame`, `ContentBlock`; `ApiClient` (`uploadFile`); the `send` from `useSessionSocket`.
- Produces:
  - `image-util.ts`: `const MAX_IMAGE_BYTES = 5 * 1024 * 1024`; `const SUPPORTED_IMAGE_TYPES = ["image/png","image/jpeg","image/gif","image/webp"]`; `function validateImage(file: { type: string; size: number }): string | null` — returns an error string if the type is unsupported or it exceeds 5 MB, else `null`; `function fileToBase64(file: Blob): Promise<string>` — reads a `Blob` to a base64 string (no data-URL prefix) via `FileReader`.
  - `slash.ts`: `const SLASH_COMMANDS: { name: string; hint: string }[]` (a small static set: `/clear`, `/compact`, `/help`, `/model`, `/cost`); `function matchSlash(text: string): { name: string; hint: string }[]` — when `text` starts with `/`, returns commands whose name starts with the typed prefix; else `[]`.
  - `Composer` — `props: { onSend: (frame: OutboundFrame) => void; onUploadFile: (file: File) => Promise<void>; disabled?: boolean }`. A multiline text input (Enter sends, Shift+Enter newline), an image picker (`<input type="file" accept="image/*" capture="environment">` → validates → base64 → an image content block sent alongside the text), a general file-upload control (calls `onUploadFile`), and a slash-command menu that appears when the text starts with `/`. Sending builds `{ type:"user", text, images:[{mediaType,dataBase64}] }` (the server's flexible `user` frame) — text-only sends omit `images`.

- [ ] **Step 1: Write the image-util + slash tests**

`packages/web/src/chat/image-util.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { validateImage, fileToBase64, MAX_IMAGE_BYTES } from "./image-util";

describe("validateImage", () => {
  it("accepts a small png", () => {
    expect(validateImage({ type: "image/png", size: 1024 })).toBeNull();
  });
  it("rejects an unsupported type", () => {
    expect(validateImage({ type: "image/bmp", size: 1024 })).toMatch(/unsupported/i);
  });
  it("rejects an oversized image", () => {
    expect(validateImage({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toMatch(/5 ?MB|too large/i);
  });
});

describe("fileToBase64", () => {
  it("base64-encodes a blob without the data-url prefix", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    const b64 = await fileToBase64(blob);
    expect(b64).toBe(btoa("hello"));
  });
});
```

`packages/web/src/chat/slash.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { matchSlash } from "./slash";

describe("matchSlash", () => {
  it("returns nothing when the text isn't a slash command", () => {
    expect(matchSlash("hello")).toEqual([]);
  });
  it("matches by prefix", () => {
    const names = matchSlash("/c").map((c) => c.name);
    expect(names).toContain("/clear");
    expect(names).toContain("/compact");
    expect(names).toContain("/cost");
    expect(names).not.toContain("/help");
  });
  it("lists all commands for a bare slash", () => {
    expect(matchSlash("/").length).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C packages/web exec vitest run src/chat/image-util.test.ts src/chat/slash.test.ts`
Expected: FAIL — `image-util` / `slash` do not exist.

- [ ] **Step 3: Write `image-util.ts` and `slash.ts`**

`packages/web/src/chat/image-util.ts`:
```ts
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Returns an error message if the image is unsupported/oversized (vision limits), else null. */
export function validateImage(file: { type: string; size: number }): string | null {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    return `Unsupported image type: ${file.type || "unknown"} (use PNG, JPEG, GIF, or WebP).`;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "Image is too large (max 5 MB).";
  }
  return null;
}

/** Read a Blob to a base64 string WITHOUT the `data:...;base64,` prefix. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}
```

`packages/web/src/chat/slash.ts`:
```ts
export const SLASH_COMMANDS: { name: string; hint: string }[] = [
  { name: "/clear", hint: "Clear the conversation context" },
  { name: "/compact", hint: "Summarize and compact the context" },
  { name: "/help", hint: "Show available commands" },
  { name: "/model", hint: "Switch the model" },
  { name: "/cost", hint: "Show token/cost usage" },
];

/** When `text` starts with `/`, return commands whose name starts with the typed prefix. */
export function matchSlash(text: string): { name: string; hint: string }[] {
  if (!text.startsWith("/")) return [];
  const prefix = text.split(/\s/)[0]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/web exec vitest run src/chat/image-util.test.ts src/chat/slash.test.ts`
Expected: PASS (image-util 4 + slash 3). If `fileToBase64` fails in jsdom, confirm jsdom provides `FileReader`/`btoa` (it does in `environment:"jsdom"`).

- [ ] **Step 5: Write the Composer test**

`packages/web/src/chat/Composer.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("sends a text message on Enter and clears the field", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "hello there{Enter}");
    expect(onSend).toHaveBeenCalledWith({ type: "user", text: "hello there" });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("does not send on Shift+Enter (newline)", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onUploadFile={vi.fn()} />);
    const box = screen.getByLabelText(/message claude/i);
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toContain("line1");
    expect((box as HTMLTextAreaElement).value).toContain("line2");
  });

  it("shows the slash menu when the text starts with /", async () => {
    render(<Composer onSend={vi.fn()} onUploadFile={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/message claude/i), "/co");
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.getByText("/cost")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/chat/Composer.test.tsx`
Expected: FAIL — `Composer` does not exist.

- [ ] **Step 7: Write `Composer`**

`packages/web/src/chat/Composer.tsx`:
```tsx
import { useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { validateImage, fileToBase64 } from "./image-util";
import { matchSlash } from "./slash";
import type { OutboundFrame } from "../types/server";

export interface ComposerProps {
  onSend: (frame: OutboundFrame) => void;
  onUploadFile: (file: File) => Promise<void>;
  disabled?: boolean;
}

interface PendingImage { mediaType: string; dataBase64: string; name: string }

export function Composer({ onSend, onUploadFile, disabled }: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | undefined>();
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const slashMatches = matchSlash(text);

  function send() {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    const frame: OutboundFrame =
      images.length > 0
        ? { type: "user", text: trimmed || undefined, images: images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 })) }
        : { type: "user", text: trimmed };
    onSend(frame);
    setText("");
    setImages([]);
    setError(undefined);
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const err = validateImage(file);
    if (err) {
      setError(err);
      return;
    }
    const dataBase64 = await fileToBase64(file);
    setImages((prev) => [...prev, { mediaType: file.type, dataBase64, name: file.name }]);
    setError(undefined);
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await onUploadFile(file);
      setError(undefined);
    } catch (uploadErr) {
      setError(uploadErr instanceof Error ? uploadErr.message : "upload failed");
    }
  }

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "var(--sp-3)", background: "var(--surface)", display: "grid", gap: "var(--sp-2)" }}>
      {error && <div role="alert" style={{ color: "var(--err)", fontSize: "var(--fs-sm)" }}>{error}</div>}
      {slashMatches.length > 0 && (
        <div style={{ display: "grid", gap: "var(--sp-1)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--sp-2)" }}>
          {slashMatches.map((c) => (
            <button key={c.name} onClick={() => setText(c.name + " ")} style={{ textAlign: "left", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", minHeight: 32, display: "flex", gap: "var(--sp-2)" }}>
              <Mono>{c.name}</Mono><span style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>{c.hint}</span>
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          {images.map((img, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-1)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "2px var(--sp-2)" }}>
              <Mono muted>{img.name}</Mono>
              <button aria-label={`Remove ${img.name}`} onClick={() => setImages((p) => p.filter((_, j) => j !== i))} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer" }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-end" }}>
        <textarea
          aria-label="Message claude"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Message claude…"
          style={{ flex: 1, minHeight: "var(--tap-min)", resize: "vertical", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text)", padding: "var(--sp-2) var(--sp-3)", font: "inherit" }}
        />
        <input ref={imageInput} type="file" accept="image/*" capture="environment" onChange={onPickImage} style={{ display: "none" }} aria-hidden tabIndex={-1} />
        <input ref={fileInput} type="file" onChange={onPickFile} style={{ display: "none" }} aria-hidden tabIndex={-1} />
        <Button variant="ghost" onClick={() => imageInput.current?.click()} aria-label="Add image">Image</Button>
        <Button variant="ghost" onClick={() => fileInput.current?.click()} aria-label="Upload file">File</Button>
        <Button variant="primary" onClick={send} disabled={disabled} aria-label="Send">Send</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run the Composer test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/chat/Composer.test.tsx`
Expected: PASS (3 cases). If the Enter test sees `onSend` not called, confirm the `onKeyDown` handler calls `e.preventDefault()` and `send()` for Enter without Shift.

- [ ] **Step 9: Render the Composer in `ChatView`**

In `packages/web/src/chat/ChatView.tsx`, add the import:
```tsx
import { Composer } from "./Composer";
```
Then render it after the scrolling area, inside the outer flex column. Find the closing of the scroll `div` and the component's closing tags:
```tsx
        {/* Task 8 adds the composer below. */}
      </div>
    </div>
  );
}
```
and replace with (the composer sends user frames over the same socket and uploads files into the session cwd via the api):
```tsx
      </div>
      <Composer
        onSend={(frame) => send(frame)}
        onUploadFile={async (file) => {
          await api.uploadFile(session.cwd, file);
        }}
      />
    </div>
  );
}
```
(Remove the now-stale `{/* Task 8 adds the composer below. */}` comment that was inside the scroll div.)

- [ ] **Step 10: Run the chat suite + typecheck + commit**

Run: `pnpm -C packages/web exec vitest run src/chat`
Expected: PASS (all chat tests incl. Composer). Then `pnpm -C packages/web typecheck` → PASS.
```bash
git add packages/web/src/chat/image-util.ts packages/web/src/chat/image-util.test.ts packages/web/src/chat/slash.ts packages/web/src/chat/slash.test.ts packages/web/src/chat/Composer.tsx packages/web/src/chat/Composer.test.tsx packages/web/src/chat/ChatView.tsx
git commit -m "feat(web): composer — text + image (camera/gallery) + file upload + slash menu"
```

---

### Task 9: Image display (assistant/tool images) + file download chips

**Files:**
- Create: `packages/web/src/chat/content-images.ts`
- Create: `packages/web/src/chat/content-images.test.ts`
- Create: `packages/web/src/chat/FileChip.tsx`
- Modify: `packages/web/src/chat/MessageList.tsx` (render image blocks + downloadable file paths)
- Modify: `packages/web/src/chat/ChatView.tsx` (pass a `downloadUrl` builder + the user's own image blocks into the view)

**Interfaces:**
- Consumes (Tasks 1–8): `Mono`; `ContentBlock`, `TurnItem`; `ApiClient.downloadUrl`.
- Produces:
  - `content-images.ts`: `function imageBlockSrc(block: Extract<ContentBlock, { type: "image" }>): string` — returns a `data:` URL (`data:<media_type>;base64,<data>`) for inline `<img>` display; `function extractFilePaths(text: string): string[]` — finds absolute-looking file paths in a tool-result/assistant text (e.g. `/private/tmp/rc-spike/spike.txt`) so they can be offered as download chips. Conservative: matches `/[\w./-]+\.\w+` absolute paths, deduped.
  - `FileChip` — `props: { path: string; href: string }` — a mono chip linking to the download URL (`<a download>`), large enough to tap.
  - `MessageList` (extended): renders `image` content blocks in a `user` turn as inline images (via `imageBlockSrc`); renders any file paths found in a `tool-result` as `FileChip`s when a `downloadUrl` builder is provided.

- [ ] **Step 1: Write the content-images test**

`packages/web/src/chat/content-images.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { imageBlockSrc, extractFilePaths } from "./content-images";

describe("imageBlockSrc", () => {
  it("builds a data url from a base64 image block", () => {
    expect(imageBlockSrc({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } })).toBe("data:image/png;base64,QUJD");
  });
});

describe("extractFilePaths", () => {
  it("finds absolute file paths in text", () => {
    const paths = extractFilePaths("File created successfully at: /private/tmp/rc-spike/spike.txt now");
    expect(paths).toContain("/private/tmp/rc-spike/spike.txt");
  });
  it("dedupes and ignores non-paths", () => {
    expect(extractFilePaths("no paths here")).toEqual([]);
    const dup = extractFilePaths("/a/b.txt and again /a/b.txt");
    expect(dup).toEqual(["/a/b.txt"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/chat/content-images.test.ts`
Expected: FAIL — `content-images` does not exist.

- [ ] **Step 3: Write `content-images.ts` and `FileChip`**

`packages/web/src/chat/content-images.ts`:
```ts
import type { ContentBlock } from "../types/server";

export function imageBlockSrc(block: Extract<ContentBlock, { type: "image" }>): string {
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

/** Find absolute-looking file paths in text (for download chips). Conservative + deduped. */
export function extractFilePaths(text: string): string[] {
  const matches = text.match(/\/[\w.\-/]+\.\w+/g) ?? [];
  return [...new Set(matches)];
}
```

`packages/web/src/chat/FileChip.tsx`:
```tsx
import { Mono } from "../ui/Mono";

export interface FileChipProps {
  path: string;
  href: string;
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

export function FileChip({ path, href }: FileChipProps) {
  return (
    <a
      href={href}
      download
      title={path}
      style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)", minHeight: 32, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "2px var(--sp-3)", color: "var(--text)", textDecoration: "none" }}
    >
      <span aria-hidden>⤓</span>
      <Mono>{basename(path)}</Mono>
    </a>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/chat/content-images.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Extend `MessageList` to render images + file chips**

In `packages/web/src/chat/MessageList.tsx`, add the imports at the top:
```tsx
import { imageBlockSrc, extractFilePaths } from "./content-images";
import { FileChip } from "./FileChip";
```
Change the `MessageListProps` interface and the component signature to accept an optional `downloadUrl`. Replace:
```tsx
export interface MessageListProps {
  view: SessionView;
}

export function MessageList({ view }: MessageListProps) {
```
with:
```tsx
export interface MessageListProps {
  view: SessionView;
  downloadUrl?: (path: string) => string;
}

export function MessageList({ view, downloadUrl }: MessageListProps) {
```
Pass `downloadUrl` into `Turn`. Replace the turns map:
```tsx
      {view.turns.map((item, i) => <Turn key={i} item={item} />)}
```
with:
```tsx
      {view.turns.map((item, i) => <Turn key={i} item={item} downloadUrl={downloadUrl} />)}
```
Update the `Turn` function to accept `downloadUrl` and use it for images + file chips. Replace the whole `function Turn(...)`:
```tsx
function Turn({ item }: { item: TurnItem }) {
  switch (item.kind) {
    case "assistant-text":
      return <div style={{ color: "var(--text)" }}><Markdown>{item.text}</Markdown></div>;
    case "tool-use":
      return (
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "baseline", color: "var(--cyan)", fontSize: "var(--fs-sm)" }}>
          <span style={{ fontFamily: "var(--font-display)" }}>Tool</span>
          <Mono>{item.name}</Mono>
          <Mono muted>{summarizeInput(item.input)}</Mono>
        </div>
      );
    case "tool-result":
      return <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}><Mono muted>{stringify(item.content)}</Mono></div>;
    case "user":
      return <div style={{ color: "var(--text)", borderLeft: "2px solid var(--border)", paddingLeft: "var(--sp-3)" }}>{renderBlocks(item.blocks)}</div>;
    case "result":
      return (
        <div style={{ color: item.isError ? "var(--err)" : "var(--ok)", fontSize: "var(--fs-sm)", borderTop: "1px solid var(--border)", paddingTop: "var(--sp-3)" }}>
          {item.isError ? "Error" : "Done"}{item.result ? ` — ${item.result}` : ""}
          {item.totalCostUsd !== undefined && <> · <Mono muted>${item.totalCostUsd.toFixed(4)}</Mono></>}
        </div>
      );
  }
}
```
with:
```tsx
function Turn({ item, downloadUrl }: { item: TurnItem; downloadUrl?: (path: string) => string }) {
  switch (item.kind) {
    case "assistant-text":
      return <div style={{ color: "var(--text)" }}><Markdown>{item.text}</Markdown></div>;
    case "tool-use":
      return (
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "baseline", color: "var(--cyan)", fontSize: "var(--fs-sm)" }}>
          <span style={{ fontFamily: "var(--font-display)" }}>Tool</span>
          <Mono>{item.name}</Mono>
          <Mono muted>{summarizeInput(item.input)}</Mono>
        </div>
      );
    case "tool-result": {
      const text = stringify(item.content);
      const paths = downloadUrl ? extractFilePaths(text) : [];
      return (
        <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)", display: "grid", gap: "var(--sp-2)" }}>
          <Mono muted>{text}</Mono>
          {paths.length > 0 && (
            <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
              {paths.map((p) => <FileChip key={p} path={p} href={downloadUrl!(p)} />)}
            </div>
          )}
        </div>
      );
    }
    case "user":
      return <div style={{ color: "var(--text)", borderLeft: "2px solid var(--border)", paddingLeft: "var(--sp-3)" }}>{renderBlocks(item.blocks)}</div>;
    case "result":
      return (
        <div style={{ color: item.isError ? "var(--err)" : "var(--ok)", fontSize: "var(--fs-sm)", borderTop: "1px solid var(--border)", paddingTop: "var(--sp-3)" }}>
          {item.isError ? "Error" : "Done"}{item.result ? ` — ${item.result}` : ""}
          {item.totalCostUsd !== undefined && <> · <Mono muted>${item.totalCostUsd.toFixed(4)}</Mono></>}
        </div>
      );
  }
}
```
Finally, render image blocks in `renderBlocks`. Replace:
```tsx
function renderBlocks(blocks: ContentBlock[]) {
  return blocks.map((b, i) =>
    b.type === "text" ? <div key={i}>{b.text}</div> : <div key={i} style={{ color: "var(--text-muted)" }}>[image]</div>,
  );
}
```
with:
```tsx
function renderBlocks(blocks: ContentBlock[]) {
  return blocks.map((b, i) =>
    b.type === "text" ? (
      <div key={i}>{b.text}</div>
    ) : (
      <img key={i} src={imageBlockSrc(b)} alt="attachment" style={{ maxWidth: "100%", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }} />
    ),
  );
}
```

- [ ] **Step 6: Pass `downloadUrl` from `ChatView`**

In `packages/web/src/chat/ChatView.tsx`, find the `MessageList` render:
```tsx
        <MessageList view={safeView} />
```
and replace with:
```tsx
        <MessageList view={safeView} downloadUrl={(path) => api.downloadUrl(path)} />
```

- [ ] **Step 7: Run the chat suite + typecheck + commit**

Run: `pnpm -C packages/web exec vitest run src/chat`
Expected: PASS (MessageList still green with the new optional prop; content-images green). Then `pnpm -C packages/web typecheck` → PASS.
```bash
git add packages/web/src/chat/content-images.ts packages/web/src/chat/content-images.test.ts packages/web/src/chat/FileChip.tsx packages/web/src/chat/MessageList.tsx packages/web/src/chat/ChatView.tsx
git commit -m "feat(web): inline image display + downloadable file chips from tool output"
```

---

### Task 10: Settings — per-session view + new-session defaults + dangerously-skip + stop

**Files:**
- Create: `packages/web/src/settings/defaults.ts`
- Create: `packages/web/src/settings/defaults.test.ts`
- Create: `packages/web/src/settings/SettingsPanel.tsx`
- Create: `packages/web/src/settings/SettingsPanel.test.tsx`
- Modify: `packages/web/src/chat/ChatHeader.tsx` (no change needed — already has `onOpenSettings`; verify)
- Modify: `packages/web/src/chat/ChatView.tsx` (open the settings panel from the header; expose stop)
- Modify: `packages/web/src/session/NewSessionWizard.tsx` (seed the wizard from stored defaults; add permission-mode)

**Honest scope note (read it):** The Plan 3 server has **no endpoint to mutate a session's settings after creation** (no `PATCH /sessions/:id`; effort/model/permission/dangerously-skip are fixed at spawn via `POST /sessions`). So the `SettingsPanel` is split: (a) for the **active session** it shows the current settings **read-only** (mono) plus a **Stop session** action (`POST /sessions/:id/stop`) and a note that changing model/effort means starting a new session; (b) it edits the **client-side defaults** used to pre-fill the next New-session wizard. This is the truthful v1 surface for spec §6.2's SettingsPanel given the Plan 3 API. (A future server `PATCH` would let (a) become editable in place.)

**Interfaces:**
- Consumes (Tasks 1–9): `Surface`, `Button`, `Mono`; `SessionMeta`; `ApiClient.stopSession`; `useStore`.
- Produces:
  - `defaults.ts`: `interface SessionDefaults { effort: string; model?: string; permissionMode: string; dangerouslySkip: boolean }`; `function loadDefaults(): SessionDefaults` (localStorage key `"roamcode.defaults"`, falling back to `{ effort:"medium", permissionMode:"default", dangerouslySkip:false }`); `function saveDefaults(d: SessionDefaults): void`; `const EFFORTS` and `const PERMISSION_MODES` exported here (the single source of truth, also used by the wizard).
  - `SettingsPanel` — `props: { session?: SessionMeta; defaults: SessionDefaults; onSaveDefaults: (d: SessionDefaults) => void; onStopSession?: (id: string) => void; onClose: () => void }`. Shows the active session's fixed settings read-only + a red, confirm-gated "Stop session"; and an editable defaults form (effort select, model input, permission-mode select, a red dangerously-skip toggle with an inline RCE warning).

- [ ] **Step 1: Write the defaults test**

`packages/web/src/settings/defaults.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadDefaults, saveDefaults } from "./defaults";

afterEach(() => localStorage.clear());

describe("session defaults", () => {
  it("returns safe fallbacks when nothing is stored", () => {
    expect(loadDefaults()).toEqual({ effort: "medium", permissionMode: "default", dangerouslySkip: false });
  });
  it("round-trips saved defaults", () => {
    saveDefaults({ effort: "high", model: "opus", permissionMode: "acceptEdits", dangerouslySkip: true });
    expect(loadDefaults()).toEqual({ effort: "high", model: "opus", permissionMode: "acceptEdits", dangerouslySkip: true });
  });
  it("ignores corrupt storage and falls back", () => {
    localStorage.setItem("roamcode.defaults", "not json");
    expect(loadDefaults().effort).toBe("medium");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/settings/defaults.test.ts`
Expected: FAIL — `defaults` does not exist.

- [ ] **Step 3: Write `defaults.ts`**

`packages/web/src/settings/defaults.ts`:
```ts
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk"] as const;

export interface SessionDefaults {
  effort: string;
  model?: string;
  permissionMode: string;
  dangerouslySkip: boolean;
}

const KEY = "roamcode.defaults";
const FALLBACK: SessionDefaults = { effort: "medium", permissionMode: "default", dangerouslySkip: false };

export function loadDefaults(): SessionDefaults {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...FALLBACK };
    const parsed = JSON.parse(raw) as Partial<SessionDefaults>;
    return {
      effort: typeof parsed.effort === "string" ? parsed.effort : FALLBACK.effort,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      permissionMode: typeof parsed.permissionMode === "string" ? parsed.permissionMode : FALLBACK.permissionMode,
      dangerouslySkip: parsed.dangerouslySkip === true,
    };
  } catch {
    return { ...FALLBACK };
  }
}

export function saveDefaults(d: SessionDefaults): void {
  localStorage.setItem(KEY, JSON.stringify(d));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/settings/defaults.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Write the SettingsPanel test**

`packages/web/src/settings/SettingsPanel.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { SessionMeta } from "../types/server";
import type { SessionDefaults } from "./defaults";

const session: SessionMeta = { id: "s1", cwd: "/p", model: "opus", effort: "high", dangerouslySkip: false, status: "running", createdAt: 1 };
const defaults: SessionDefaults = { effort: "medium", permissionMode: "default", dangerouslySkip: false };

describe("SettingsPanel", () => {
  it("shows the active session's fixed settings read-only", () => {
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onStopSession={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("stops the session after a confirm", async () => {
    const onStop = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPanel session={session} defaults={defaults} onSaveDefaults={vi.fn()} onStopSession={onStop} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /stop session/i }));
    expect(onStop).toHaveBeenCalledWith("s1");
    vi.restoreAllMocks();
  });

  it("saves edited defaults", async () => {
    const onSave = vi.fn();
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/default effort/i), "high");
    await userEvent.click(screen.getByRole("button", { name: /save defaults/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("confirms before enabling dangerously-skip in defaults", async () => {
    const onSave = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPanel session={undefined} defaults={defaults} onSaveDefaults={onSave} onClose={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/dangerously skip permissions/i));
    expect(window.confirm).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/settings/SettingsPanel.test.tsx`
Expected: FAIL — `SettingsPanel` does not exist.

- [ ] **Step 7: Write `SettingsPanel`**

`packages/web/src/settings/SettingsPanel.tsx`:
```tsx
import { useState } from "react";
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { EFFORTS, PERMISSION_MODES } from "./defaults";
import type { SessionDefaults } from "./defaults";
import type { SessionMeta } from "../types/server";

export interface SettingsPanelProps {
  session?: SessionMeta;
  defaults: SessionDefaults;
  onSaveDefaults: (d: SessionDefaults) => void;
  onStopSession?: (id: string) => void;
  onClose: () => void;
}

const fieldStyle: React.CSSProperties = {
  minHeight: "var(--tap-min)", background: "var(--surface)", border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)", color: "var(--text)", padding: "0 var(--sp-3)", font: "inherit",
};

export function SettingsPanel({ session, defaults, onSaveDefaults, onStopSession, onClose }: SettingsPanelProps) {
  const [draft, setDraft] = useState<SessionDefaults>(defaults);

  function toggleDanger(checked: boolean) {
    if (checked && !window.confirm("Enable --dangerously-skip-permissions for NEW sessions? This allows the agent to run tools without asking — remote code execution risk.")) {
      return;
    }
    setDraft((d) => ({ ...d, dangerouslySkip: checked }));
  }

  return (
    <div role="dialog" aria-label="Settings" style={{ position: "fixed", inset: 0, background: "var(--bg)", display: "grid", placeItems: "center", padding: "var(--sp-5)", zIndex: 50, overflowY: "auto" }}>
      <Surface level={1} as="section">
        <div style={{ padding: "var(--sp-5)", display: "grid", gap: "var(--sp-4)", width: "min(92vw, 480px)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong className="display" style={{ fontSize: "var(--fs-lg)" }}>Settings</strong>
            <Button variant="ghost" onClick={onClose} aria-label="Close settings">Close</Button>
          </div>

          {session && (
            <section style={{ display: "grid", gap: "var(--sp-2)" }}>
              <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1 }}>This session (fixed at start)</div>
              <div>Directory: <Mono>{session.cwd}</Mono></div>
              <div>Model: <Mono>{session.model ?? "default"}</Mono></div>
              <div>Effort: <Mono>{session.effort ?? "default"}</Mono></div>
              <div>Skip permissions: <Mono>{String(session.dangerouslySkip)}</Mono></div>
              <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", margin: 0 }}>Model/effort/permissions are set when a session starts. To change them, start a new session.</p>
              {onStopSession && (
                <Button
                  variant="danger"
                  onClick={() => { if (window.confirm("Stop this session? The running claude process will be terminated.")) onStopSession(session.id); }}
                  aria-label="Stop session"
                >
                  Stop session
                </Button>
              )}
            </section>
          )}

          <section style={{ display: "grid", gap: "var(--sp-3)", borderTop: "1px solid var(--border)", paddingTop: "var(--sp-4)" }}>
            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", textTransform: "uppercase", letterSpacing: 1 }}>Defaults for new sessions</div>
            <label style={{ display: "grid", gap: "var(--sp-2)" }}>
              <span style={{ fontSize: "var(--fs-sm)" }}>Default effort</span>
              <select value={draft.effort} onChange={(e) => setDraft((d) => ({ ...d, effort: e.target.value }))} style={fieldStyle}>
                {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: "var(--sp-2)" }}>
              <span style={{ fontSize: "var(--fs-sm)" }}>Default model (optional)</span>
              <input value={draft.model ?? ""} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value || undefined }))} placeholder="default" style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }} />
            </label>
            <label style={{ display: "grid", gap: "var(--sp-2)" }}>
              <span style={{ fontSize: "var(--fs-sm)" }}>Default permission mode</span>
              <select value={draft.permissionMode} onChange={(e) => setDraft((d) => ({ ...d, permissionMode: e.target.value }))} style={fieldStyle}>
                {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", color: draft.dangerouslySkip ? "var(--err)" : "var(--text)" }}>
              <input type="checkbox" checked={draft.dangerouslySkip} onChange={(e) => toggleDanger(e.target.checked)} />
              <span>Dangerously skip permissions (RCE risk)</span>
            </label>
            <Button variant="primary" onClick={() => onSaveDefaults(draft)} aria-label="Save defaults">Save defaults</Button>
          </section>

          <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", margin: 0 }}>The access token is stored in this browser only (localStorage).</p>
        </div>
      </Surface>
    </div>
  );
}
```

- [ ] **Step 8: Run the SettingsPanel test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/settings/SettingsPanel.test.tsx`
Expected: PASS (4 cases). If the dangerously-skip test fails because the confirm is not called, confirm `toggleDanger` calls `window.confirm` only when turning it ON.

- [ ] **Step 9: Open SettingsPanel from `ChatView`; seed the wizard from defaults**

In `packages/web/src/chat/ChatView.tsx`, add state + the panel. Add the imports:
```tsx
import { useState } from "react";
import { SettingsPanel } from "../settings/SettingsPanel";
import { loadDefaults, saveDefaults } from "../settings/defaults";
import { useStore } from "../store/store";
```
(If `useState`/`useStore` are already imported, keep a single import — `useState` joins the existing `react` import; `useStore` is already imported.) Add inside `ChatView`, after the existing hooks:
```tsx
  const [settingsOpen, setSettingsOpen] = useState(false);
  const setSessions = useStore((s) => s.setSessions);
  const sessions = useStore((s) => s.sessions);
```
Pass `onOpenSettings` to the header — change:
```tsx
      <ChatHeader session={session} wireState={wireState} />
```
to:
```tsx
      <ChatHeader session={session} wireState={wireState} onOpenSettings={() => setSettingsOpen(true)} />
```
Render the panel just before the component's final closing `</div>` and `)`. Change the end of the returned JSX:
```tsx
      <Composer
        onSend={(frame) => send(frame)}
        onUploadFile={async (file) => {
          await api.uploadFile(session.cwd, file);
        }}
      />
    </div>
  );
}
```
to:
```tsx
      <Composer
        onSend={(frame) => send(frame)}
        onUploadFile={async (file) => {
          await api.uploadFile(session.cwd, file);
        }}
      />
      {settingsOpen && (
        <SettingsPanel
          session={session}
          defaults={loadDefaults()}
          onSaveDefaults={(d) => { saveDefaults(d); setSettingsOpen(false); }}
          onStopSession={async (id) => {
            await api.stopSession(id);
            setSessions(sessions.map((s) => (s.id === id ? { ...s, status: "stopped" } : s)));
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
```

In `packages/web/src/session/NewSessionWizard.tsx`, seed the form from stored defaults and add the permission-mode select. Replace the `EFFORTS`/`PERMISSION_MODES` local constants and the state initializers. Change:
```tsx
import { pushRecentDir } from "../picker/recents";
import type { ApiClient } from "../api/client";
import type { SessionMeta } from "../types/server";

export interface NewSessionWizardProps {
  api: Pick<ApiClient, "listDir" | "createSession">;
  recents: string[];
  onCreated: (session: SessionMeta) => void;
  onClose: () => void;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;

export function NewSessionWizard({ api, recents, onCreated, onClose }: NewSessionWizardProps) {
  const [cwd, setCwd] = useState<string | undefined>();
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>("medium");
  const [model, setModel] = useState("");
  const [dangerouslySkip, setDangerouslySkip] = useState(false);
```
to:
```tsx
import { pushRecentDir } from "../picker/recents";
import { loadDefaults, EFFORTS } from "../settings/defaults";
import type { ApiClient } from "../api/client";
import type { SessionMeta } from "../types/server";

export interface NewSessionWizardProps {
  api: Pick<ApiClient, "listDir" | "createSession">;
  recents: string[];
  onCreated: (session: SessionMeta) => void;
  onClose: () => void;
}

export function NewSessionWizard({ api, recents, onCreated, onClose }: NewSessionWizardProps) {
  const seeded = loadDefaults();
  const [cwd, setCwd] = useState<string | undefined>();
  const [effort, setEffort] = useState<string>(seeded.effort);
  const [model, setModel] = useState(seeded.model ?? "");
  const [dangerouslySkip, setDangerouslySkip] = useState(seeded.dangerouslySkip);
```
Then update the effort `<select>` onChange cast (it is now `string`, not the tuple type). Change:
```tsx
            <select value={effort} onChange={(e) => setEffort(e.target.value as (typeof EFFORTS)[number])} style={selectStyle}>
```
to:
```tsx
            <select value={effort} onChange={(e) => setEffort(e.target.value)} style={selectStyle}>
```

- [ ] **Step 10: Run the settings + session + chat suites + typecheck + commit**

Run: `pnpm -C packages/web exec vitest run src/settings src/session src/chat`
Expected: PASS (settings 7, session list/wizard/status still green, chat green). Then `pnpm -C packages/web typecheck` → PASS. (The wizard no longer has an unused `PERMISSION_MODES`; it now imports `EFFORTS` from `defaults`.)
```bash
git add packages/web/src/settings packages/web/src/chat/ChatView.tsx packages/web/src/session/NewSessionWizard.tsx
git commit -m "feat(web): settings panel (per-session read-only + defaults + dangerously-skip + stop)"
```

---

### Task 11: PWA layer — manifest, service worker, installable, offline-aware reconnect

**Files:**
- Create: `packages/web/public/icon-192.svg`
- Create: `packages/web/public/icon-512.svg`
- Create: `packages/web/src/pwa/online-status.ts`
- Create: `packages/web/src/pwa/online-status.test.ts`
- Create: `packages/web/src/pwa/ConnectionBanner.tsx`
- Create: `packages/web/src/pwa/ConnectionBanner.test.tsx`
- Modify: `packages/web/vite.config.ts` (register `vite-plugin-pwa`)
- Modify: `packages/web/src/main.tsx` (register the service worker via the plugin's virtual module)
- Modify: `packages/web/src/App.tsx` (render the `ConnectionBanner`)

**Interfaces:**
- Consumes (Tasks 1–10): `useStore`/component primitives as needed.
- Produces:
  - `online-status.ts`: `function getOnline(): boolean` (`navigator.onLine`); `function subscribeOnline(cb: (online: boolean) => void): () => void` — adds `online`/`offline` window listeners, returns an unsubscribe; `function useOnline(): boolean` — a React hook wrapping the above.
  - `ConnectionBanner` — `props: { online: boolean }` — when offline, renders a thin amber-edged banner ("Offline — reconnecting when the link returns"); when online, renders nothing. `role="status"` + text (a11y).
  - The PWA: a web manifest (name "roamcode", `theme_color #0E1116`, `background_color #0E1116`, `display "standalone"`, the two SVG icons), an auto-update service worker that precaches the built shell so the app loads offline. **No push** (out of scope; noted).

- [ ] **Step 1: Write the online-status test**

`packages/web/src/pwa/online-status.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeOnline } from "./online-status";

afterEach(() => vi.restoreAllMocks());

describe("subscribeOnline", () => {
  it("fires the callback on online/offline events and unsubscribes", () => {
    const cb = vi.fn();
    const off = subscribeOnline(cb);
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(cb).toHaveBeenCalledWith(false);
    expect(cb).toHaveBeenCalledWith(true);
    off();
    cb.mockClear();
    window.dispatchEvent(new Event("offline"));
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/web exec vitest run src/pwa/online-status.test.ts`
Expected: FAIL — `online-status` does not exist.

- [ ] **Step 3: Write `online-status.ts`**

`packages/web/src/pwa/online-status.ts`:
```ts
import { useEffect, useState } from "react";

export function getOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function subscribeOnline(cb: (online: boolean) => void): () => void {
  const onOnline = () => cb(true);
  const onOffline = () => cb(false);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(getOnline());
  useEffect(() => subscribeOnline(setOnline), []);
  return online;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/web exec vitest run src/pwa/online-status.test.ts`
Expected: PASS (1 case).

- [ ] **Step 5: Write the ConnectionBanner test + component**

`packages/web/src/pwa/ConnectionBanner.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionBanner } from "./ConnectionBanner";

describe("ConnectionBanner", () => {
  it("renders nothing when online", () => {
    const { container } = render(<ConnectionBanner online={true} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("announces offline with text (not color alone)", () => {
    render(<ConnectionBanner online={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(/offline/i);
  });
});
```

`packages/web/src/pwa/ConnectionBanner.tsx`:
```tsx
export interface ConnectionBannerProps {
  online: boolean;
}

export function ConnectionBanner({ online }: ConnectionBannerProps) {
  if (online) return null;
  return (
    <div
      role="status"
      style={{ background: "var(--surface-2)", borderBottom: "2px solid var(--accent)", color: "var(--text)", padding: "var(--sp-2) var(--sp-4)", fontSize: "var(--fs-sm)", textAlign: "center" }}
    >
      Offline — the session keeps running on your machine; we’ll reconnect when the link returns.
    </div>
  );
}
```

- [ ] **Step 6: Run the test to verify it fails then passes**

Run: `pnpm -C packages/web exec vitest run src/pwa/ConnectionBanner.test.tsx`
Expected: first FAIL (component missing), then after Step 5's component exists, PASS (2 cases). (Author the test, run it RED, add the component in the same step, run GREEN.)

- [ ] **Step 7: Add the app icons**

`packages/web/public/icon-192.svg` (a simple amber "live wire" mark on the ink background — scalable, no binary tooling needed):
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="36" fill="#0E1116"/>
  <path d="M24 96 H66 L80 60 L104 132 L120 96 H168" fill="none" stroke="#E8A33D" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

`packages/web/public/icon-512.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0E1116"/>
  <path d="M64 256 H176 L213 160 L277 352 L320 256 H448" fill="none" stroke="#E8A33D" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

- [ ] **Step 8: Register `vite-plugin-pwa`**

Replace `packages/web/vite.config.ts` with:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.svg", "icon-512.svg"],
      manifest: {
        name: "roamcode",
        short_name: "roamcode",
        description: "Operate Claude Code sessions on your machine, remotely.",
        theme_color: "#0E1116",
        background_color: "#0E1116",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
          { src: "icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        // Precache the built shell so the app loads offline. API/WS calls are NOT cached
        // (they need the live server); only the static app shell is precached.
        globPatterns: ["**/*.{js,css,html,svg,woff,woff2}"],
        navigateFallbackDenylist: [/^\/sessions/, /^\/fs/],
      },
      // Web Push is intentionally out of scope for this plan (no server push endpoint yet).
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5273 },
});
```

- [ ] **Step 9: Register the service worker + render the banner**

In `packages/web/src/main.tsx`, register the SW via the plugin's virtual module. Add after the existing imports:
```tsx
import { registerSW } from "virtual:pwa-register";
```
And before the `createRoot(...)` call:
```tsx
// Auto-update the service worker (precached shell loads offline). Safe no-op in dev.
registerSW({ immediate: true });
```
(If `tsc` flags the virtual module, the `vite-plugin-pwa` client types are pulled in via `vite/client`; add a triple-slash directive at the very top of `main.tsx` to be explicit: `/// <reference types="vite-plugin-pwa/client" />`.)

In `packages/web/src/App.tsx`, render the offline banner above the layout. Add the imports:
```tsx
import { ConnectionBanner } from "./pwa/ConnectionBanner";
import { useOnline } from "./pwa/online-status";
```
Add inside `App` (near the other hooks):
```tsx
  const online = useOnline();
```
Wrap the `ready`-phase return so the banner sits above everything. Change the final `return (` of the ready path from:
```tsx
  return (
    <>
      <AppLayout sessionList={list}>
```
to:
```tsx
  return (
    <>
      <ConnectionBanner online={online} />
      <AppLayout sessionList={list}>
```

- [ ] **Step 10: Run the pwa suite + typecheck + build**

Run:
```bash
pnpm -C packages/web exec vitest run src/pwa
pnpm -C packages/web typecheck
pnpm -C packages/web build
```
Expected: tests PASS (online-status 1 + ConnectionBanner 2); typecheck PASS; `vite build` emits `packages/web/dist/` including `manifest.webmanifest`, `sw.js` (or `workbox-*.js`), the precache manifest, and the SVG icons. If the build errors on `virtual:pwa-register`, confirm the triple-slash reference in `main.tsx` (Step 9).

- [ ] **Step 11: Commit**

```bash
git add packages/web/public packages/web/src/pwa packages/web/vite.config.ts packages/web/src/main.tsx packages/web/src/App.tsx
git commit -m "feat(web): PWA layer — manifest, service worker (offline shell), install, online banner"
```

---

### Task 12: Final wiring — full-app flow test (login → list → new session → chat → permission) + suite/build pass

**Files:**
- Create: `packages/web/src/App.test.tsx`
- Create: `packages/web/test/e2e/README.md` (optional E2E note — describes running Playwright against the Plan 3 server + interactive mock; not wired into CI)
- Modify: `packages/web/src/App.tsx` only if the flow test surfaces a wiring gap

**Interfaces:**
- Consumes: the whole app (`App`) + all prior modules. No new production interfaces.
- Produces: a high-level component test that drives the real `App` with `fetch` + `WebSocket` stubbed, proving the screens connect end-to-end (login persists a token and the session list loads; opening the wizard creates a session and selects it; a streamed frame and a permission frame render and the permission can be answered over the (stubbed) socket). This is the component-level E2E; an optional Playwright spec (against a mock/real-mock server) is documented but kept out of CI per the Global Constraints.

- [ ] **Step 1: Write the full-app flow test**

`packages/web/src/App.test.tsx`:
```tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { useStore } from "./store/store";
import type { SessionMeta } from "./types/server";

// --- A controllable fake WebSocket so the test can push frames into the chat view. ---
class FakeWS {
  static last: FakeWS | undefined;
  url: string;
  readyState = 1;
  OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) { this.url = url; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  push(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const session: SessionMeta = { id: "sess-1", cwd: "/home/u/proj", dangerouslySkip: false, status: "running", createdAt: 1 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ token: undefined, sessions: [], activeSessionId: undefined, views: {} });
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sessions") && method === "GET") return jsonResponse({ sessions: [] });
    if (url.endsWith("/sessions") && method === "POST") return jsonResponse({ session }, 201);
    if (url.includes("/fs/list")) return jsonResponse({ path: "/home/u", entries: [] });
    if (url.includes(`/sessions/${session.id}`) && !url.includes("/stop")) {
      return jsonResponse({ session, history: [] });
    }
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  // jsdom may not implement window.location.origin meaningfully; config falls back to it.
});

afterEach(() => vi.unstubAllGlobals());

describe("App full flow", () => {
  it("logs in, lists sessions, starts a new session, and renders streamed + permission frames", async () => {
    render(<App />);

    // 1) Login (tokenless dev path).
    await userEvent.click(await screen.findByRole("button", { name: /without a token/i }));

    // 2) Empty session list → open the wizard.
    await screen.findByRole("button", { name: /new session/i });
    await userEvent.click(screen.getByRole("button", { name: /new session/i }));

    // 3) Directory picker → use the current dir → settings → start.
    await userEvent.click(await screen.findByRole("button", { name: /use this directory/i }));
    await userEvent.click(await screen.findByRole("button", { name: /start session/i }));

    // 4) The chat view for the created session renders (header shows the cwd).
    await waitFor(() => expect(screen.getByText("/home/u/proj")).toBeInTheDocument());

    // 5) Push a streamed text delta over the socket → it renders live.
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    FakeWS.last!.push({ seq: 1, kind: "event", payload: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working on it" } } } });
    await waitFor(() => expect(screen.getByText(/working on it/i)).toBeInTheDocument());

    // 6) Push a permission frame → the iris awaiting-you prompt appears → answer Allow over WS.
    FakeWS.last!.push({ seq: 2, kind: "permission", payload: { requestId: "req-1", kind: "hook_callback", toolName: "Write", toolInput: { file_path: "/home/u/proj/a.txt" } } });
    const region = await screen.findByRole("region", { name: /permission request/i });
    await userEvent.click(within(region).getByRole("button", { name: /^allow$/i }));
    expect(FakeWS.last!.sent.some((s) => s.includes("req-1") && s.includes("allow"))).toBe(true);

    // 7) A result frame clears the prompt.
    FakeWS.last!.push({ seq: 3, kind: "result", payload: { type: "result", result: "Created the file", permissionDenials: [] } });
    await waitFor(() => expect(screen.queryByRole("region", { name: /permission request/i })).not.toBeInTheDocument());
    expect(screen.getByText(/created the file/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the flow test to verify it fails (or surfaces wiring gaps)**

Run: `pnpm -C packages/web exec vitest run src/App.test.tsx`
Expected: This exercises only already-built wiring. It may PASS immediately. If it FAILS, the failure points at a real wiring gap — fix the smallest thing in `App.tsx`/`ChatView.tsx` that the assertion demands (do NOT change the test's expectations; they encode the intended flow). Common gaps and fixes:
  - The wizard's "Use this directory" not advancing → confirm Task 5 Step 13 wired `onNew` to open the wizard and `onCreated` selects the session.
  - The chat view not appearing after create → confirm Task 6 Step 10 renders `ChatView` for `activeSessionId`.
  - The streamed text not rendering → confirm the socket hook (Task 6) feeds `applyFrame` and the reducer (Task 3) accumulates `text_delta`.
  - The permission Allow not sending → confirm Task 7 Step 5 passes `send` into `PermissionPrompt.onAnswer`.

- [ ] **Step 3: Make it green**

If Step 2 was RED, apply the minimal wiring fix it pointed to, then re-run:
Run: `pnpm -C packages/web exec vitest run src/App.test.tsx`
Expected: PASS (the full login→list→new→chat→stream→permission→result flow).

- [ ] **Step 4: Document the optional Playwright E2E (kept out of CI)**

`packages/web/test/e2e/README.md`:
```markdown
# Optional E2E (not in CI)

This component suite (`src/App.test.tsx`) is the default end-to-end coverage: it drives the real
`App` with `fetch` + `WebSocket` stubbed.

A browser-level Playwright E2E is **optional** and MUST run against a MOCK backend — either a tiny
stub server or the real Plan 3 `@roamcode/server` started with the interactive mock
(`packages/server/test/helpers/mock-claude-interactive.mjs`) bound to `127.0.0.1`. It must NEVER hit
the real `claude` binary or any external network, and it is excluded from CI (per the plan's Global
Constraints).

Suggested flow to script later: start the mock server → `pnpm -C packages/web preview` →
`playwright test` that logs in, starts a session via the directory picker, sends a message, answers a
permission, and downloads a file. Wire it as an opt-in `test:e2e` script when added.
```

- [ ] **Step 5: Run the ENTIRE web suite + typecheck + build**

Run:
```bash
pnpm -C packages/web exec vitest run
pnpm -C packages/web typecheck
pnpm -C packages/web build
```
Expected: ALL web tests PASS (ui, auth, api, ws, store, session, picker, chat, settings, pwa, App). `typecheck` PASS. `vite build` emits `packages/web/dist/` (the app shell + manifest + service worker + icons). 

- [ ] **Step 6: Confirm the root suite is unaffected**

Run: `pnpm test`
Expected: the root `vitest.config.ts` globs `packages/*/test/**/*.test.ts` (node env). The web package's tests live under `packages/web/src/**` and `packages/web/test/**` and use the web's OWN `vitest.config.ts` (jsdom) — they are NOT picked up by the root config, so `pnpm test` still runs only the `protocol` + `server` suites and they remain green. (If any web `*.test.ts` accidentally matches the root glob and fails under node env, move it under `src/` or confirm the root `include` does not reach `packages/web/test/` — the web E2E note file is `.md`, not a test.)

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/App.test.tsx packages/web/test/e2e/README.md
git commit -m "test(web): full-app flow test (login→list→new→chat→stream→permission→result) + E2E note"
```

---

## Self-Review

**1. Spec coverage** (vs the prompt's Plan 4 scope, spec §1/§6.2/§6.3, the design direction, and the Plan 3 server contract):

- **Design system + static screenshotted mockup (sign-off gate)** — `packages/web` scaffold (Vite+React+TS), the token system baked in VERBATIM (`--bg #0E1116` … `--iris #C9A2FF` … the type scale + Space Grotesk/Inter/JetBrains Mono via `@fontsource`), base primitives (`Button`/`Surface`/`Mono`/`LiveWire`), a two-screen static mockup (chat-with-awaiting-permission + directory picker), and a screenshot script saving desktop + mobile PNGs to `docs/design/` with an explicit STOP-for-sign-off → **Task 1**. ✓
- **App shell + auth/login** (enter+store the token in `localStorage`, remember it, validate via `GET /sessions`, 401 → back to login with an error, tokenless local-dev path) → **Task 2** (login + token store + shell) + **Task 4** (validation/401 handling). XSS caveat documented in `token-store.ts` and the login/settings copy. ✓
- **REST `api` client + reconnecting `ws` client + Zustand store** mapping `ServerFrame`s → session state. REST covers every documented route with `Authorization: Bearer`/`?token=`; `wsUrl` builds `?token=`+`?since=`; `SessionSocket` auto-reconnects with backoff carrying `?since=<lastSeq>`; the `frame-reducer` folds `stream_event` deltas / final `assistant` / `user` tool-results / `permission` / `result` / `diagnostic` / `exit` into a `SessionView` → **Task 3**. ✓
- **Session list + status** using the live-wire/state colors (`wireStateForSession` maps errored→error, stopped→idle, running→live `wireState`) → **Task 4**. ✓
- **New-session wizard + first-class DIRECTORY PICKER** (recents via localStorage, git badges+branch from `DirEntry.isGitRepo`/`gitBranch`, fuzzy subsequence filter, breadcrumb + up/into, mobile-sheet full-height `role="dialog"`, large tap targets) → `POST /sessions` → **Task 5**. ✓
- **Chat view** rendering assistant text + `stream_event` token deltas + tool-use activity + result; markdown + code (`react-markdown` + a mono `CodeBlock`, shiki noted as a non-blocking enhancement); mono for paths/tools; the live-wire header (the alive remote-link signal) → **Task 6**. ✓
- **Permission prompts (allow/deny tool gate)** inline, large tap targets, answerable on mobile → WS `{type:"permission",requestId,decision}`; the iris "awaiting you" card; `AskUserQuestion` is rendered as a clearly-labeled tool permission (its question shown for context) with allow/deny only — the plan does NOT fake multi-option answering via `reason` (which the server does not deliver to the model). **Full AskUserQuestion answering** is deferred to Plan 5 with rationale → **Task 7** + the "Out of scope → Plan 5" section. ✓
- **Composer** — text (Enter send / Shift+Enter newline) + image upload (`<input accept="image/*" capture>` → 5 MB/type validation → base64 → `{type:"user", text, images:[…]}`) + general file upload (`POST /fs/upload` multipart) + slash-command menu → **Task 8**. ✓
- **Image display** (assistant/user image blocks as inline `data:` URLs) + **file download** chips (paths extracted from tool output → `GET /fs/download?path=&token=` via `downloadUrl`) → **Task 9**. ✓
- **Settings** — effort (low/medium/high/xhigh/max), model, permission-mode, dangerously-skip (red + confirm) — as **client-side defaults for new sessions** plus a **read-only view of the active session's fixed settings + a Stop action** (honest, because Plan 3 has no settings-mutation endpoint; called out in Task 10's scope note) → **Task 10**. ✓
- **PWA layer** — `vite-plugin-pwa` manifest (name/theme `#0E1116`/standalone/SVG icons), an `autoUpdate` service worker precaching the shell for offline load, an offline-aware `ConnectionBanner` + `useOnline` reconnect signal (the socket already auto-reconnects with `?since=`), app icons → **Task 11**. **Web Push is explicitly out of scope** (no server endpoint in Plan 3) and noted in the manifest task + Out-of-scope. ✓
- **Final wiring + component/E2E pass** — a full-app flow test (login→list→new-session→chat→stream→permission→result) with `fetch`+`WebSocket` stubbed, plus an optional-Playwright-against-mock note kept out of CI → **Task 12**. ✓
- **a11y floor** — visible `:focus-visible` ring globally; `prefers-reduced-motion` disables animations globally + `LiveWire` checks it; color always paired with text (`LiveWire`, `PermissionPrompt`, `ConnectionBanner` all carry readable labels); large tap targets (`--tap-min: 44px`) on every interactive row/button; mobile-first responsive layout (`AppLayout` CSS media query). → Tasks 1, 4, 5, 7, 11. ✓
- **Conforms ONLY to the documented server API; tests never hit real claude/network** — all REST/WS shapes mirror `transport.ts`/`session-hub.ts`/`replay-buffer.ts`/`fs-service.ts`; every test stubs `fetch`/`WebSocket` or uses pure inputs; no `@anthropic-ai/*`, no `ANTHROPIC_API_KEY`. → Global Constraints + every task. ✓
- **Right-sized to 12 tasks**, each with an independently testable deliverable and red→green→commit. Task 1 is the sign-off gate. ✓

**2. Placeholder scan:** No "TBD/TODO/implement later/add error handling" left as work. Every code step shows the complete file or an exact before/after edit. The `eslint-disable-next-line react-hooks/exhaustive-deps` in `DirectoryPicker` (mount-once `navigate`) is intentional, not a placeholder. The Task 5 note about deleting the unused `PERMISSION_MODES` is resolved concretely in Task 10 (the wizard imports `EFFORTS` from `settings/defaults` and drops the local constant). The "Task N adds X here" comments in `ChatView` are removed by the task that adds X (Tasks 7/8/10 each strip the stale comment they replace). The `devOptions.enabled:false` and `navigateFallbackDenylist` are deliberate config, not stubs. ✓

**3. Type consistency (names/signatures across tasks):**
- `ServerFrame`/`ServerFrameKind`/`SessionMeta`/`DirEntry`/`DirListing`/`ContentBlock`/`PermissionPayload`/`ResultPayload`/`DiagnosticPayload`/`OutboundFrame` — defined once in `types/server.ts` (Task 2), consumed unchanged by the api client (3), socket (3), reducer (3), every component, and `App` (4–12). They mirror the Plan 3 server exports exactly. ✓
- `createApiClient`/`ApiClient` (`listSessions`/`getSession`/`createSession`/`stopSession`/`listDir`/`uploadFile`/`downloadUrl`) + `ApiError` + `wsUrl` — defined Task 3, consumed by `App` (4), wizard (5 via `Pick<ApiClient,…>`), `ChatView` (6/8/9/10), settings (10). The wizard's `Pick<ApiClient, "listDir" | "createSession">` is a subset of the full client, so passing `api` satisfies it. ✓
- `createSessionSocket`/`SessionSocket`/`SocketStatus` — defined Task 3, consumed by `useSessionSocket` (6); `send`/`close` signatures match. ✓
- `SessionView`/`TurnItem`/`emptyView`/`reduceFrame` — defined Task 3, consumed by the store (3), `MessageList` (6/9), `ChatView` (6/7). `MessageList` gains an OPTIONAL `downloadUrl?` in Task 9, so Task 6's `<MessageList view={…}/>` callsite still typechecks; Task 9 updates the callsite to pass it. ✓
- `LiveWire`/`LiveWireState` — defined Task 1, consumed by `mock-data` (1), `SessionList` (4), `status.ts` (4), `ChatHeader` (6). The 7 states match the reducer's `wireState` assignments. ✓
- `wireStateForSession(meta, view?)` — defined Task 4, consumed by `App` (4) and `ChatView` (6); the `view?` arg is `{ wireState }`-shaped, satisfied by a `SessionView`. ✓
- `SessionDefaults`/`loadDefaults`/`saveDefaults`/`EFFORTS`/`PERMISSION_MODES` — defined Task 10 in `settings/defaults.ts`; `EFFORTS` re-used by the wizard (Task 10 edit) so there is ONE source of truth; the wizard's old local `EFFORTS`/`PERMISSION_MODES` are removed in the same edit. ✓
- `parseAskUserQuestion`/`PermissionPrompt`/`QuestionPrompt` (Task 7), `validateImage`/`fileToBase64`/`matchSlash`/`Composer` (Task 8), `imageBlockSrc`/`extractFilePaths`/`FileChip` (Task 9), `useOnline`/`subscribeOnline`/`ConnectionBanner` (Task 11) — each defined once and consumed only after definition. ✓
- `App` accumulates wiring across Tasks 2→4→5→6→10→11 via explicit before/after edits (each edit quotes the exact prior text it replaces), so a reader executing in order never hits a stale snippet. `useState`/`useStore` imports are de-duplicated by the "keep a single import" notes. ✓
- `import type` used for every type-only import (required by `verbatimModuleSyntax: true`); React value imports (`useState`, `useEffect`, `useRef`, `createRoot`, `ReactMarkdown`) are value imports, `ReactNode`/`Components`/all `…Props`/all server types are `import type`. ✓

---

## Notes carried to later plans

- **Web Push (deferred):** when a server `push` component + subscribe endpoint land, add a `pwa/push.ts` (VAPID subscribe via the service worker) and trigger a notification on a `result` frame while the document is hidden — the `ConnectionBanner`/`useOnline` plumbing and the SW registration are already here.
- **Settings mutation (needs a server `PATCH /sessions/:id`):** Task 10's per-session settings are read-only because Plan 3 fixes them at spawn. A future server endpoint makes the active-session form editable in place (the `SettingsPanel` already has the fields; point its inputs at the session instead of the defaults).
- **shiki syntax highlighting:** `CodeBlock` is a synchronous mono `<pre>` baseline; a later enhancement can lazy-load shiki's highlighter and swap inner HTML without changing `CodeBlock`'s props or any callsite.
- **Pinned directories:** the picker shows recents (localStorage) + git-aware browse; a "pinned/favorites" set and `~/.claude/projects/*` discovery (spec §6.3) layer onto the same `DirectoryPicker` recents section when the server exposes a projects endpoint.
- **Real-mock Playwright E2E:** the component flow test (`App.test.tsx`) is the CI gate; the optional browser E2E (documented in `test/e2e/README.md`) runs against the Plan 3 server + interactive mock and is wired as an opt-in `test:e2e` in Plan 6's CI work, never against real `claude`.
