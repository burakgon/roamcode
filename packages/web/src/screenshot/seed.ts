// Dev-only screenshot seed. Builds realistic ServerFrames and folds them through the REAL store
// reducer so the harness renders the REAL components at a representative live state — no network,
// no WebSocket, no API. This module is imported only by the screenshot entry (screenshot.tsx),
// never by the production app (main.tsx), so it can never affect the shipped bundle.

import { useStore } from "../store/store";
import type {
  DirListing,
  QuestionPayload,
  ResumableSession,
  ServerFrame,
  SessionMeta,
} from "../types/server";
import type { PendingImage } from "../chat/Composer";

// A small, valid 48×48 PNG (amber gradient) so the composer thumbnail renders a real image, not a
// broken-image glyph. Generated once; the bytes are inert and self-contained.
export const THUMB_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAmUlEQVR4nO3OYWbCAQCH4f/F3nslmSRJkkmSJEmSmSRJkiRJkmRmZ3iP0S326fec4CksYRkr+IFVrGEdG9jEFraxg5/YxR72cYBDHOEYJzjFGc5xgV/4jUtc4Ro3uMUd7vGARzzhGS94xRve8YFPfOEP/uIfRUIJJZRQQgkllFBCCSWUUEIJJZRQQgkllFBCCSWUUEIJ/V/oDaLwLPEQMX96AAAAAElFTkSuQmCC";

export const SCREENSHOT_TOKEN = "screenshot-demo-token";

// The path Claude "sent" to the chat as an attachment. The harness's downloadUrl resolver maps this
// exact path to an inline image data-URI so the AttachmentCard previews a real picture (below).
export const ATTACHMENT_IMG_PATH = "/Users/burakgon/Developer/remote-coder/docs/coverage-heatmap.png";

// A 640×300 warm clay-coral gradient PNG used as the inline preview for the chart Claude sent. Inert
// bytes, self-contained — a real <img> source so the attachment card looks like the shipped product,
// not a placeholder. (Tiny base64; decodes to a smooth liquid-glass clay-coral gradient.)
export const ATTACHMENT_IMG_DATA_URI =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0d0a07"/>
          <stop offset="1" stop-color="#1c130c"/>
        </linearGradient>
        <linearGradient id="b" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#d6592c"/>
          <stop offset="1" stop-color="#ff9c64"/>
        </linearGradient>
      </defs>
      <rect width="640" height="300" fill="url(#g)"/>
      ${[42, 70, 58, 86, 64, 92, 78, 110, 96, 128, 116, 150]
        .map((h, i) => {
          const x = 36 + i * 48;
          const y = 250 - h;
          return `<rect x="${x}" y="${y}" width="30" height="${h}" rx="4" fill="url(#b)" opacity="${(0.55 + i * 0.035).toFixed(2)}"/>`;
        })
        .join("")}
      <text x="36" y="34" fill="#f1ebdf" font-family="monospace" font-size="18" font-weight="600">coverage by package</text>
      <line x1="36" y1="250" x2="604" y2="250" stroke="#3a2f24" stroke-width="1"/>
    </svg>`,
  );

/** The harness's download resolver: the seeded attachment path → its inline data-URI; else "". */
export function screenshotDownloadUrl(path: string): string {
  if (path === ATTACHMENT_IMG_PATH) return ATTACHMENT_IMG_DATA_URI;
  return "";
}

// Four sessions for the rail: one Awaiting you (active, with meta.awaiting so the loud "needs you"
// indicator + global badge render), one Streaming, one Idle, and one Dormant (clean-exit, resumable).
export const SESSIONS: SessionMeta[] = [
  {
    id: "sess-active",
    cwd: "/Users/burakgon/Developer/remote-coder",
    model: "claude-opus-4-8",
    dangerouslySkip: false,
    status: "running",
    createdAt: Date.now() - 1000 * 60 * 24,
    lastActivityAt: Date.now() - 1000 * 18,
    awaiting: true,
  },
  {
    id: "sess-stream",
    cwd: "/Users/burakgon/work/api-gateway",
    model: "claude-opus-4-8",
    dangerouslySkip: false,
    status: "running",
    createdAt: Date.now() - 1000 * 60 * 40,
    lastActivityAt: Date.now() - 1000 * 60 * 2,
  },
  {
    id: "sess-idle",
    cwd: "/Users/burakgon/notes",
    dangerouslySkip: false,
    status: "running",
    createdAt: Date.now() - 1000 * 60 * 90,
    lastActivityAt: Date.now() - 1000 * 60 * 18,
  },
  {
    id: "sess-dormant",
    cwd: "/Users/burakgon/work/legacy-import",
    model: "claude-opus-4-8",
    dangerouslySkip: false,
    status: "dormant",
    createdAt: Date.now() - 1000 * 60 * 60 * 6,
    lastActivityAt: Date.now() - 1000 * 60 * 60 * 5,
  },
];

export const ACTIVE_ID = "sess-active";

// The checkpoint id of the user turn — the id the rewind affordance + the Rewind sheet target.
export const CHECKPOINT_ID = "ck-7f3a-aud-1";

const USER_TEXT =
  "Audit the streaming reducer for the rate-limiter and send me a coverage chart when you're done.";

const ASSISTANT_TEXT = `Here's what I found auditing \`frame-reducer.ts\`. Two turns were double-counted on reconnect because the replay range was inclusive. The fix gates each frame on \`seq > lastSeq\`:

\`\`\`ts
export function reduceFrame(view: SessionView, frame: ServerFrame): SessionView {
  // Idempotent on replay: a frame we've already applied is a no-op.
  if (frame.seq <= view.lastSeq) return view;
  const next = { ...view, lastSeq: Math.max(view.lastSeq, frame.seq) };
  // …fold the frame into the per-session view…
  return next;
}
\`\`\`

Coverage moved up across the board after adding the dedup tests:

| Package | Before | After | Δ |
|---|---:|---:|---:|
| protocol | 91% | 98% | +7 |
| server | 84% | 93% | +9 |
| web | 88% | 95% | +7 |

I generated a heatmap of the per-package coverage and sent it to the chat below.`;

// A realistic transcript for the ACTIVE session: a user turn (carrying a checkpoint id so its rewind
// affordance renders), an assistant prose + table + code turn, a multi-step "Worked" tool cluster
// (Read → Grep → Bash → Edit, each with a result), an attachment Claude sent to chat (the chart), and
// finally a pending permission (the iris "Awaiting you" card).
function activeFrames(): ServerFrame[] {
  return [
    {
      seq: 1,
      kind: "event",
      payload: {
        type: "user",
        uuid: CHECKPOINT_ID,
        message: { content: [{ type: "text", text: USER_TEXT }] },
      },
    },
    {
      seq: 2,
      kind: "event",
      payload: { type: "assistant", message: { content: [{ type: "text", text: ASSISTANT_TEXT }] } },
    },
    // A contiguous run of tool plumbing → folds into ONE collapsed "Worked · 4 steps" cluster.
    {
      seq: 3,
      kind: "event",
      payload: {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "packages/web/src/store/frame-reducer.ts" } },
          ],
        },
      },
    },
    {
      seq: 4,
      kind: "event",
      payload: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "263 lines read" }] } },
    },
    {
      seq: 5,
      kind: "event",
      payload: {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "lastSeq", path: "packages/web/src" } }],
        },
      },
    },
    {
      seq: 6,
      kind: "event",
      payload: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "11 matches across 3 files" }] } },
    },
    {
      seq: 7,
      kind: "event",
      payload: {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "pnpm -C packages/web test -- frame-reducer" } }],
        },
      },
    },
    {
      seq: 8,
      kind: "event",
      payload: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "Test Files  1 passed (1)\\n     Tests  18 passed (18)" }] } },
    },
    {
      seq: 9,
      kind: "event",
      payload: {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t4", name: "Edit", input: { file_path: "packages/web/src/store/frame-reducer.ts" } }],
        },
      },
    },
    {
      seq: 10,
      kind: "event",
      payload: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t4", content: "Applied 1 edit" }] } },
    },
    // Claude proactively SENT the coverage chart to the chat (send_image MCP → attachment frame).
    {
      seq: 11,
      kind: "attachment",
      payload: {
        id: "att-1",
        path: ATTACHMENT_IMG_PATH,
        name: "coverage-heatmap.png",
        caption: "Per-package coverage after the dedup tests — server saw the biggest jump (+9).",
        isImage: true,
      },
    },
    // The "Awaiting you" moment — a pending permission for the write.
    {
      seq: 12,
      kind: "permission",
      payload: {
        requestId: "req-write-1",
        kind: "hook_callback",
        toolName: "Write",
        toolInput: { file_path: "packages/web/src/store/frame-reducer.ts" },
        toolUseId: "t4",
      },
    },
  ];
}

// Give the Streaming session a little live text so its rail dot reads "Streaming".
function streamFrames(): ServerFrame[] {
  return [
    {
      seq: 1,
      kind: "event",
      payload: { type: "user", message: { content: [{ type: "text", text: "Add a token-bucket rate limiter to the gateway." }] } },
    },
    {
      seq: 2,
      kind: "event",
      payload: {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Sketching the limiter — I'll add a per-key bucket…" } },
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------
// Scene seed data (consumed by AppShot for the non-chat overlays). These are plain fixtures handed to
// the REAL components (QuestionPrompt, NewSessionWizard/DirectoryPicker, ResumePicker) so each overlay
// renders from shipped code, not a mock.
// ---------------------------------------------------------------------------------------------------

// A multiple-choice ask_user question with an ASCII/code PREVIEW per option — single-select.
export const QUESTION: QuestionPayload = {
  requestId: "q-empty-state",
  askId: "ask-1",
  toolUseId: "tu-ask-1",
  toolInput: {},
  questions: [
    {
      header: "Empty-state layout",
      question: "Which layout should I use for the “no sessions yet” screen?",
      multiSelect: false,
      options: [
        {
          label: "Centered hero",
          description: "A single mark + CTA, vertically centered.",
          preview: "┌────────────────────┐\n│                    │\n│        ▢ rc        │\n│   Start a session  │\n│      [  +  New ]   │\n│                    │\n└────────────────────┘",
        },
        {
          label: "Split with recents",
          description: "CTA on the left, recent directories on the right.",
          preview: "┌──────────┬─────────┐\n│  ▢ rc    │ recents │\n│  Start   │ ~/dev   │\n│ [+ New]  │ ~/work  │\n│          │ ~/notes │\n└──────────┴─────────┘",
        },
        {
          label: "Guided checklist",
          description: "Three setup steps with progress ticks.",
          preview: "□ Pick a directory\n□ Choose effort/model\n□ Start the session",
        },
      ],
    },
  ],
};

// The directory listing the harness's picker renders (git-aware, with branches).
export const DIR_LISTING: DirListing = {
  path: "/Users/burakgon/Developer",
  parent: "/Users/burakgon",
  entries: [
    { name: "remote-coder", path: "/Users/burakgon/Developer/remote-coder", isDirectory: true, isGitRepo: true, gitBranch: "feat/readme" },
    { name: "api-gateway", path: "/Users/burakgon/Developer/api-gateway", isDirectory: true, isGitRepo: true, gitBranch: "main" },
    { name: "design-system", path: "/Users/burakgon/Developer/design-system", isDirectory: true, isGitRepo: true, gitBranch: "release/4.2" },
    { name: "scratch", path: "/Users/burakgon/Developer/scratch", isDirectory: true, isGitRepo: false },
    { name: "notes", path: "/Users/burakgon/Developer/notes", isDirectory: true, isGitRepo: false },
    { name: "playground", path: "/Users/burakgon/Developer/playground", isDirectory: true, isGitRepo: true, gitBranch: "main" },
  ],
};

export const PICKER_RECENTS = [
  "/Users/burakgon/Developer/remote-coder",
  "/Users/burakgon/work/api-gateway",
  "/Users/burakgon/notes",
];

// Past conversations for the Resume picker, recent-first.
export const RESUMABLE: ResumableSession[] = [
  {
    sessionId: "r-1",
    cwd: "/Users/burakgon/Developer/remote-coder",
    gitBranch: "feat/readme",
    summary: "Wire the Rewind sheet into ChatView and add the checkpoint markers.",
    lastActivity: Date.now() - 1000 * 60 * 14,
    messageCount: 42,
  },
  {
    sessionId: "r-2",
    cwd: "/Users/burakgon/work/api-gateway",
    gitBranch: "main",
    summary: "Add a token-bucket rate limiter with per-key buckets and a Redis backstop.",
    lastActivity: Date.now() - 1000 * 60 * 60 * 3,
    messageCount: 28,
  },
  {
    sessionId: "r-3",
    cwd: "/Users/burakgon/Developer/design-system",
    gitBranch: "release/4.2",
    summary: "Migrate the Button tokens to the liquid-glass palette and fix focus rings.",
    lastActivity: Date.now() - 1000 * 60 * 60 * 26,
    messageCount: 65,
  },
  {
    sessionId: "r-4",
    cwd: "/Users/burakgon/notes",
    summary: "Draft the launch announcement and the comparison table vs. remote control.",
    lastActivity: Date.now() - 1000 * 60 * 60 * 50,
    messageCount: 12,
  },
];

// The composer pre-fill: a draft message + one attached image thumbnail (REAL <img>).
export const COMPOSER_TEXT = "Then open a PR and send me the diff stat.";
export const COMPOSER_IMAGES: PendingImage[] = [
  { id: "img-1", mediaType: "image/png", dataBase64: THUMB_B64, name: "diagram.png" },
];

/** Seed the REAL Zustand store via its own setters + reducer, then mark the harness ready. */
export function seedStore(): void {
  const store = useStore.getState();
  store.setToken(SCREENSHOT_TOKEN);
  store.setSessions(SESSIONS);
  store.applyFrames(ACTIVE_ID, activeFrames());
  store.applyFrames("sess-stream", streamFrames());
  store.setActive(ACTIVE_ID);
}
