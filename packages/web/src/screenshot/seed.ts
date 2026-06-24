// Dev-only screenshot seed. Builds realistic ServerFrames and folds them through the REAL store
// reducer so the harness renders the REAL components at a representative live state — no network,
// no WebSocket, no API. This module is imported only by the screenshot entry (screenshot.tsx),
// never by the production app (main.tsx), so it can never affect the shipped bundle.

import { useStore } from "../store/store";
import type { ServerFrame, SessionMeta } from "../types/server";
import type { PendingImage } from "../chat/Composer";

// A small, valid 48×48 PNG (amber gradient) so the composer thumbnail renders a real image, not a
// broken-image glyph. Generated once; the bytes are inert and self-contained.
export const THUMB_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAmUlEQVR4nO3OYWbCAQCH4f/F3nslmSRJkkmSJEmSmSRJkiRJkmRmZ3iP0S326fec4CksYRkr+IFVrGEdG9jEFraxg5/YxR72cYBDHOEYJzjFGc5xgV/4jUtc4Ro3uMUd7vGARzzhGS94xRve8YFPfOEP/uIfRUIJJZRQQgkllFBCCSWUUEIJJZRQQgkllFBCCSWUUEIJ/V/oDaLwLPEQMX96AAAAAElFTkSuQmCC";

export const SCREENSHOT_TOKEN = "screenshot-demo-token";

// Four sessions for the rail: one Awaiting you (active, with meta.awaiting so the loud "needs you"
// indicator + global badge render), one Streaming, one Idle, and one Dormant (clean-exit, resumable).
export const SESSIONS: SessionMeta[] = [
  {
    id: "sess-active",
    cwd: "/Users/burakgon/Developer/remote-coder",
    model: "claude-opus-4-8",
    dangerouslySkip: false,
    status: "running",
    createdAt: Date.now() - 1000 * 60 * 12,
    lastActivityAt: Date.now() - 1000 * 30,
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

const ASSISTANT_TEXT = `I'll capture the protocol notes into a spike file, then run the tests. Here's the shape of the frame the server emits:

\`\`\`ts
interface ServerFrame {
  seq: number;
  kind: "event" | "permission" | "result";
  payload: unknown;
}
\`\`\`

Writing that to disk now — I'll need permission for the write.`;

// A realistic transcript for the ACTIVE session, as the server would replay it: a user turn, an
// assistant text turn with a fenced code block, a tool-use row (Write), then a pending permission.
function activeFrames(): ServerFrame[] {
  return [
    {
      seq: 1,
      kind: "event",
      payload: {
        type: "user",
        message: {
          content: [{ type: "text", text: "Capture the protocol notes into a spike file, then run the tests." }],
        },
      },
    },
    {
      seq: 2,
      kind: "event",
      payload: {
        type: "assistant",
        message: { content: [{ type: "text", text: ASSISTANT_TEXT }] },
      },
    },
    {
      seq: 3,
      kind: "event",
      payload: {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "Write",
              input: { file_path: "/private/tmp/rc-spike/spike.txt", content: "…" },
            },
          ],
        },
      },
    },
    {
      seq: 4,
      kind: "permission",
      payload: {
        requestId: "req-write-1",
        kind: "can_use_tool",
        toolName: "Write",
        toolInput: { file_path: "/private/tmp/rc-spike/spike.txt" },
        toolUseId: "toolu_01",
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
      payload: {
        type: "user",
        message: { content: [{ type: "text", text: "Add a token-bucket rate limiter to the gateway." }] },
      },
    },
    {
      seq: 2,
      kind: "event",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Sketching the limiter — I'll add a per-key bucket…" },
        },
      },
    },
  ];
}

// The composer pre-fill: a draft message + one attached image thumbnail (REAL <img>).
export const COMPOSER_TEXT = "Also add a short README note about the spike, and link it from docs/.";
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
