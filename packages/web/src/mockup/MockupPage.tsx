import type { CSSProperties } from "react";
import { Surface } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Mono } from "../ui/Mono";
import { LiveWire } from "../ui/LiveWire";
import type { LiveWireState } from "../ui/LiveWire";
import { MOCK_SESSIONS, MOCK_RECENTS, MOCK_DIR_LISTING } from "./mock-data";

/**
 * Static, data-mocked preview of the two key screens for design sign-off:
 *  (A) the chat view mid-session with an "awaiting you" permission prompt,
 *  (B) the directory picker sheet.
 * This page is NOT wired to any store/API — it exists only so Task 1 can be screenshotted.
 *
 * The visual direction is "mission control for a remote agent": a cool-ink base, a warm
 * amber signal accent, and a single rare IRIS accent reserved for "Claude is awaiting your
 * answer". The signature element is the per-session "live wire" activity indicator.
 */

const RAIL_DOT: Record<LiveWireState, string> = {
  idle: "var(--text-muted)",
  dormant: "var(--text-faint)",
  thinking: "var(--accent)",
  streaming: "var(--accent)",
  awaiting: "var(--iris)",
  "running-tool": "var(--cyan)",
  success: "var(--ok)",
  error: "var(--err)",
};

const eyebrow: CSSProperties = {
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.16em",
};

const inputStyle: CSSProperties = {
  flex: 1,
  minHeight: "var(--tap-min)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text)",
  padding: "0 var(--sp-3)",
  fontFamily: "var(--font-body)",
  fontSize: "var(--fs-sm)",
};

function GitBadge({ branch }: { branch?: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-1)",
        color: "var(--accent)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-xs)",
        border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
        borderRadius: 999,
        padding: "2px var(--sp-2)",
        background: "color-mix(in srgb, var(--accent) 8%, transparent)",
      }}
    >
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }} />
      {branch}
    </span>
  );
}

/** The signature element, scaled up: a slim animated "wire" of signal segments. */
function WireGlyph({ state }: { state: LiveWireState }) {
  const color = RAIL_DOT[state];
  const live = state === "thinking" || state === "streaming" || state === "awaiting";
  return (
    <span aria-hidden style={{ display: "inline-flex", alignItems: "center", gap: 3, height: 12 }}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: live ? 5 + (i % 2 === 0 ? 7 : 3) : 4,
            borderRadius: 2,
            background: color,
            opacity: live ? 1 : 0.45,
            animation: live ? `rc-wire 1.1s ease-in-out ${i * 0.12}s infinite` : "none",
          }}
        />
      ))}
      <style>{`@keyframes rc-wire { 0%,100% { transform: scaleY(0.45); } 50% { transform: scaleY(1); } }`}</style>
    </span>
  );
}

function SessionRail() {
  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-4)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-3)" }}>
        <span className="display" style={{ fontSize: "var(--fs-2xl)", letterSpacing: "-0.02em" }}>
          remote<span style={{ color: "var(--accent)" }}>·</span>coder
        </span>
      </div>
      <div style={eyebrow}>mission control</div>

      <Surface level={1} as="section">
        <div
          style={{
            padding: "var(--sp-3) var(--sp-4)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={eyebrow}>Sessions</span>
          <span
            style={{
              color: "var(--ok)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-xs)",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--sp-1)",
            }}
          >
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }} />
            linked
          </span>
        </div>
        <div style={{ display: "grid" }}>
          {MOCK_SESSIONS.map((s, idx) => {
            const active = idx === 0;
            return (
              <div
                key={s.id}
                style={{
                  display: "grid",
                  gap: "var(--sp-2)",
                  padding: "var(--sp-3) var(--sp-4)",
                  borderBottom: idx < MOCK_SESSIONS.length - 1 ? "1px solid var(--border)" : "none",
                  borderLeft: active ? "2px solid var(--iris)" : "2px solid transparent",
                  background: active ? "color-mix(in srgb, var(--iris) 6%, transparent)" : "transparent",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-2)" }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
                    <WireGlyph state={s.state} />
                    <strong className="display" style={{ fontSize: "var(--fs-sm)" }}>
                      {s.name}
                    </strong>
                  </span>
                  <LiveWire state={s.state} aria-label={`${s.name} session is ${s.state}`} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
                  <Mono muted>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        display: "block",
                        maxWidth: "100%",
                        fontSize: "var(--fs-xs)",
                      }}
                    >
                      {s.cwd}
                    </span>
                  </Mono>
                </div>
                {s.branch && (
                  <div>
                    <GitBadge branch={s.branch} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ padding: "var(--sp-3) var(--sp-4)", borderTop: "1px solid var(--border)" }}>
          <Button variant="ghost" aria-label="Start a new session">
            + New session
          </Button>
        </div>
      </Surface>
    </aside>
  );
}

function ChatView() {
  return (
    <Surface level={1} as="section">
      {/* Header with the live-wire — the session's signature status line */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "var(--sp-3)",
          padding: "var(--sp-4)",
          borderBottom: "1px solid var(--border)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0 }}>
          <strong className="display" style={{ fontSize: "var(--fs-lg)" }}>
            remote-coder
          </strong>
          <Mono muted>
            ~/Developer/remote-coder · <span style={{ color: "var(--accent)" }}>main</span>
          </Mono>
        </div>
        <LiveWire state="awaiting" aria-label="Session is awaiting your decision" />
      </div>

      {/* Conversation */}
      <div style={{ padding: "var(--sp-4)", display: "grid", gap: "var(--sp-4)" }}>
        <div style={{ display: "grid", gap: "var(--sp-2)" }}>
          <span style={eyebrow}>you</span>
          <div style={{ color: "var(--text)", lineHeight: 1.55 }}>
            Capture the protocol notes into a spike file, then run the tests.
          </div>
        </div>

        <div style={{ display: "grid", gap: "var(--sp-2)" }}>
          <span style={{ ...eyebrow, color: "var(--accent)" }}>claude</span>
          <div style={{ color: "var(--text)", lineHeight: 1.55 }}>
            I'll create <Mono>spike.txt</Mono> with the captured protocol notes, then run the tests.
          </div>
          {/* tool-call chip */}
          <div
            style={{
              display: "inline-flex",
              alignSelf: "start",
              alignItems: "center",
              gap: "var(--sp-2)",
              padding: "var(--sp-2) var(--sp-3)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid color-mix(in srgb, var(--cyan) 30%, var(--border))",
              background: "color-mix(in srgb, var(--cyan) 7%, transparent)",
              fontSize: "var(--fs-sm)",
            }}
          >
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--cyan)" }} />
            <Mono>Write</Mono>
            <span style={{ color: "var(--text-muted)" }}>
              <Mono muted>/private/tmp/rc-spike/spike.txt</Mono>
            </span>
          </div>
        </div>

        {/* The iris "awaiting you" moment — the one rare attention color */}
        <Surface level={2} as="article">
          <div
            style={{
              padding: "var(--sp-4)",
              borderLeft: "3px solid var(--iris)",
              borderRadius: "var(--radius)",
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--iris) 22%, transparent), 0 0 24px color-mix(in srgb, var(--iris) 12%, transparent)",
              display: "grid",
              gap: "var(--sp-3)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
              <LiveWire state="awaiting" aria-label="Claude is awaiting your answer" />
              <span style={{ color: "var(--iris)", fontFamily: "var(--font-display)", fontWeight: 600 }}>
                Awaiting you — permission
              </span>
            </div>
            <div style={{ lineHeight: 1.55 }}>
              Allow <Mono>Write</Mono> to <Mono muted>/private/tmp/rc-spike/spike.txt</Mono>?
            </div>
            <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap" }}>
              <Button variant="primary">Allow once</Button>
              <Button variant="ghost">Always allow</Button>
              <Button variant="danger">Deny</Button>
            </div>
          </div>
        </Surface>
      </div>

      {/* Composer */}
      <div
        style={{ padding: "var(--sp-4)", borderTop: "1px solid var(--border)", display: "flex", gap: "var(--sp-2)" }}
      >
        <input placeholder="Message claude…" aria-label="Message claude" style={inputStyle} />
        <Button variant="primary" aria-label="Send message">
          Send
        </Button>
      </div>
    </Surface>
  );
}

function DirectoryPicker() {
  return (
    <Surface level={1} as="section">
      <div
        style={{ padding: "var(--sp-4)", borderBottom: "1px solid var(--border)", display: "grid", gap: "var(--sp-3)" }}
      >
        <strong className="display" style={{ fontSize: "var(--fs-lg)" }}>
          Pick a directory
        </strong>
        <input
          placeholder="Filter directories…"
          aria-label="Filter directories"
          style={{ ...inputStyle, width: "100%", fontFamily: "var(--font-mono)" }}
        />
        <div style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <span style={eyebrow}>at</span>
          <Mono>~/Developer/remote-coder</Mono>
        </div>
      </div>

      <div style={{ padding: "var(--sp-4)", display: "grid", gap: "var(--sp-5)" }}>
        <div style={{ display: "grid", gap: "var(--sp-1)" }}>
          <div style={eyebrow}>Pinned &amp; recent</div>
          {MOCK_RECENTS.map((d) => (
            <div
              key={d.path}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "var(--sp-3)",
                minHeight: "var(--tap-min)",
                padding: "0 var(--sp-2)",
                borderRadius: "var(--radius-sm)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <Mono>{d.path}</Mono>
              {d.isGitRepo && <GitBadge branch={d.branch} />}
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: "var(--sp-1)" }}>
          <div style={eyebrow}>Browse</div>
          {MOCK_DIR_LISTING.map((d) => (
            <div
              key={d.path}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "var(--sp-3)",
                minHeight: "var(--tap-min)",
                padding: "0 var(--sp-2)",
                borderRadius: "var(--radius-sm)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
                <span aria-hidden style={{ color: "var(--text-muted)" }}>
                  ▸
                </span>
                <Mono>{d.name}/</Mono>
              </span>
              {d.isGitRepo && <GitBadge branch={d.branch} />}
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          padding: "var(--sp-4)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          justifyContent: "flex-end",
          gap: "var(--sp-3)",
        }}
      >
        <Button variant="ghost">Cancel</Button>
        <Button variant="primary">Open session here</Button>
      </div>
    </Surface>
  );
}

export function MockupPage() {
  return (
    <div
      style={{
        minHeight: "100%",
        padding: "var(--sp-5)",
        background:
          "radial-gradient(120% 80% at 100% 0%, color-mix(in srgb, var(--accent) 5%, transparent), transparent 55%), var(--bg)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "var(--rail-w) minmax(0, 1fr)",
          gap: "var(--sp-6)",
          maxWidth: 1180,
          margin: "0 auto",
        }}
        className="rc-shell"
      >
        <SessionRail />
        <main style={{ display: "grid", gap: "var(--sp-6)", minWidth: 0 }}>
          <ChatView />
          <DirectoryPicker />
        </main>
      </div>

      {/* Mobile-first: the rail stacks above the main column on narrow screens. */}
      <style>{`
        @media (max-width: 860px) {
          .rc-shell { grid-template-columns: 1fr !important; gap: var(--sp-5) !important; }
        }
      `}</style>
    </div>
  );
}
