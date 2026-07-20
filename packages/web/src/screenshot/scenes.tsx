// Screenshot scenes — renders the REAL components with mock data so the README/marketing shots are pixel-
// accurate (real theme, real chrome) without a live server, auth, or a real provider session. Dev/tooling only:
// this file is never referenced by index.html, so it never ships in the production bundle. Regenerate with
// `node packages/web/scripts/shots.mjs`.
import { useEffect, useState, type ReactElement } from "react";
import { TerminalView } from "../chat/TerminalView";
import { SessionList } from "../session/SessionList";
import { AppLayout } from "../AppLayout";
import { SplitWorkspace } from "../split/SplitWorkspace";
import { makeLeaf, splitLeaf } from "../split/layout";
import { DirectoryPicker } from "../picker/DirectoryPicker";
import { TerminalFiles } from "../chat/TerminalFiles";
import { ImageEditorModal } from "../chat/ImageEditorModal";
import { UpdatePanel } from "../update/UpdatePanel";
import { LoginScreen } from "../auth/LoginScreen";
import { AgentsPage } from "../agents/AgentsPage";
import { AutomationsPage } from "../automations/AutomationsPage";
import { PrimaryNav } from "../navigation/PrimaryNav";
import type {
  AgentRuntimeRecord,
  NodeRecord,
  SessionAutomationDefinition,
  SessionAutomationRun,
} from "../api/v2/types";
import type { SessionMeta, UsageInfo, VersionInfo, DirListing } from "../types/server";
// Provider-specific TUI frames replayed byte-for-byte into the real xterm terminal. Claude frames are real
// sanitized captures; Codex is a fixed sanitized frame matching its native TUI layout.
import claudeMobile from "./claude-mobile.ansi?raw";
import claudeDesktop from "./claude-desktop.ansi?raw";
import claudeStart from "./claude-mobile-start.ansi?raw";
import codexMobile from "./codex-mobile.ansi?raw";

const NOW = 1_735_732_800_000; // fixed clock so relative times are deterministic

function mockSocket(frame: string) {
  // LF → CRLF so xterm returns to column 0 on each newline (a raw capture uses bare \n → stair-steps).
  const bytes = new TextEncoder().encode(frame.replace(/\r?\n/g, "\r\n"));
  return (opts: { onData: (b: Uint8Array) => void; onStatus?: (s: string) => void }) => {
    setTimeout(() => {
      opts.onStatus?.("open");
      opts.onData(bytes);
    }, 60);
    return { sendInput() {}, sendResize() {}, close() {} };
  };
}

const SESSION: SessionMeta = {
  id: "s-orders",
  cwd: "/Users/you/dev/acme-api",
  model: "opus",
  effort: "high",
  dangerouslySkip: false,
  status: "running",
  createdAt: NOW - 42 * 60_000,
  claudeVersion: "2.1.187",
  awaiting: false,
  lastActivityAt: NOW - 30_000,
  mode: "terminal",
};
const CODEX_SESSION: SessionMeta = {
  id: "s-codex-auth",
  provider: "codex",
  cwd: "/Users/you/dev/acme-api",
  model: "gpt-5.6-sol",
  effort: "xhigh",
  sandbox: "read-only",
  approvalPolicy: "on-request",
  dangerouslySkip: false,
  status: "running",
  createdAt: NOW - 18 * 60_000,
  awaiting: false,
  activity: "idle",
  lastActivityAt: NOW - 12_000,
  mode: "terminal",
  identityState: "exact",
  providerSessionId: "thread-demo-codex",
};
const SESSIONS: SessionMeta[] = [
  { ...SESSION, awaiting: true, lastActivityAt: NOW - 20_000 },
  {
    id: "s-web",
    cwd: "/Users/you/dev/storefront-web",
    dangerouslySkip: true,
    status: "running",
    createdAt: NOW - 3 * 3_600_000,
    lastActivityAt: NOW - 8 * 60_000,
    mode: "terminal",
  },
  {
    id: "s-infra",
    cwd: "/Users/you/dev/infra",
    dangerouslySkip: false,
    status: "dormant",
    createdAt: NOW - 26 * 3_600_000,
    lastActivityAt: NOW - 5 * 3_600_000,
    mode: "terminal",
  },
];
const USAGE: UsageInfo = {
  session: { percent: 21, resets: "7:19pm" },
  week: { percent: 41, resets: "Mon 9:00am" },
  fetchedAt: NOW,
};
const VERSION: VersionInfo = {
  current: "v2.0.0",
  latest: "v2.0.0",
  behind: 0,
  releaseCount: 0,
  updatable: true,
  updateAvailable: false,
  updateAction: "update",
  installation: "managed",
  runningVersion: "2.0.0",
  activeVersion: "2.0.0",
  installDrift: false,
  checkStatus: "fresh",
  runningBuild: "2.0.0",
  buildDrift: false,
  terminalAvailable: true,
  changelog: [
    {
      id: "1.2.0:0",
      version: "1.2.0",
      subject: "one-tap two-finger scroll hint for the terminal",
      group: "new",
      when: "2h ago",
      date: "",
    },
    {
      id: "1.2.0:1",
      version: "1.2.0",
      subject: "match the mobile terminal chrome to the app theme",
      group: "improvements",
      when: "5h ago",
      date: "",
    },
    {
      id: "1.1.0:0",
      version: "1.1.0",
      subject: "long-press selects directly on the live terminal",
      group: "improvements",
      when: "6h ago",
      date: "",
    },
    {
      id: "1.1.0:1",
      version: "1.1.0",
      subject: "heal the iOS post-update dead-touch on first open",
      group: "fixes",
      when: "1d ago",
      date: "",
    },
  ],
};

const NODE: NodeRecord = {
  id: "node-local",
  owner: { type: "person", id: "person-local" },
  name: "studio-mac",
  status: "online",
  platform: "darwin-arm64",
  lastSeenAt: NOW - 4_000,
  aliases: [{ kind: "direct-host", id: "direct-local" }],
};

const RUNTIMES: AgentRuntimeRecord[] = [
  {
    id: "runtime-codex",
    nodeId: NODE.id,
    provider: "codex",
    displayName: "Codex",
    availability: "available",
    authState: "ready",
    version: "0.14.0",
    capabilities: ["launch", "resume", "task-bootstrap"],
    activeSessionCount: 2,
    observedAt: NOW - 4_000,
  },
  {
    id: "runtime-claude",
    nodeId: NODE.id,
    provider: "claude",
    displayName: "Claude Code",
    availability: "available",
    authState: "ready",
    version: "2.1.187",
    capabilities: ["launch", "resume", "task-bootstrap"],
    activeSessionCount: 1,
    observedAt: NOW - 4_000,
  },
];

const AUTOMATIONS: SessionAutomationDefinition[] = [
  {
    id: "automation-release",
    owner: { type: "person", id: "person-local" },
    name: "Release readiness",
    enabled: true,
    nodeId: NODE.id,
    agentRuntimeId: RUNTIMES[0]!.id,
    provider: "codex",
    cwd: "/Users/you/dev/acme-api",
    instruction: "Run the release checks, summarize any regression, and prepare a changelog draft.",
    runtimeOptions: {},
    trigger: { type: "manual" },
    triggers: [
      {
        id: "trigger-release-schedule",
        type: "schedule",
        enabled: true,
        cron: "0 9 * * 1-5",
        timeZone: "Europe/Istanbul",
        missedRunPolicy: "skip",
      },
    ],
    revision: 4,
    createdAt: NOW - 14 * 86_400_000,
    updatedAt: NOW - 2 * 3_600_000,
  },
  {
    id: "automation-triage",
    owner: { type: "person", id: "person-local" },
    name: "Incoming issue triage",
    enabled: true,
    nodeId: NODE.id,
    agentRuntimeId: RUNTIMES[1]!.id,
    provider: "claude",
    cwd: "/Users/you/dev/storefront-web",
    instruction:
      "Reproduce the reported issue, identify the smallest safe fix, and leave the Session ready for review.",
    runtimeOptions: {},
    trigger: { type: "manual" },
    triggers: [{ id: "trigger-triage-webhook", type: "webhook", enabled: true, hookId: "hook-triage" }],
    revision: 2,
    createdAt: NOW - 8 * 86_400_000,
    updatedAt: NOW - 38 * 60_000,
  },
];

const AUTOMATION_RUNS: SessionAutomationRun[] = [
  {
    id: "run-release",
    automationId: AUTOMATIONS[0]!.id,
    definitionRevision: 4,
    invocationId: "invocation-release",
    sessionId: "session-release",
    nodeId: NODE.id,
    agentRuntimeId: RUNTIMES[0]!.id,
    cwd: AUTOMATIONS[0]!.cwd,
    status: "ready",
    createdAt: NOW - 2 * 3_600_000,
    updatedAt: NOW - 118 * 60_000,
  },
];

const AGENT_CLIENT = {
  listNodes: async () => [NODE],
  listNodeRuntimes: async () => RUNTIMES,
};

const AUTOMATION_CLIENT = {
  listAutomations: async () => AUTOMATIONS,
  listNodes: async () => [NODE],
  listNodeRuntimes: async () => RUNTIMES,
  createAutomation: async () => ({ automation: AUTOMATIONS[0]!, webhookSecrets: [] }),
  updateAutomation: async () => ({ automation: AUTOMATIONS[0]!, webhookSecrets: [] }),
  deleteAutomation: async () => undefined,
  runAutomation: async () => {
    throw new Error("Screenshot fixture does not run automations");
  },
  listAutomationRuns: async () => AUTOMATION_RUNS,
  listAutomationActivity: async () => [],
  rotateAutomationWebhookSecret: async () => ({ automation: AUTOMATIONS[0]!, webhookSecret: undefined as never }),
};

function productNavigation(
  destination: "sessions" | "automations" | "agents",
  variant: "vertical" | "bottom" = "vertical",
) {
  return <PrimaryNav activeDestination={destination} onDestinationChange={() => {}} variant={variant} />;
}
const RECENTS = ["/Users/you/dev/acme-api", "/Users/you/dev/storefront-web", "/Users/you/dev/infra"];
const listDir = async (path?: string): Promise<DirListing> => ({
  path: path ?? "/Users/you/dev",
  parent: "/Users/you",
  entries: [
    { name: "acme-api", path: "/Users/you/dev/acme-api", isDirectory: true, isGitRepo: true, gitBranch: "main" },
    {
      name: "storefront-web",
      path: "/Users/you/dev/storefront-web",
      isDirectory: true,
      isGitRepo: true,
      gitBranch: "feat/checkout",
    },
    { name: "infra", path: "/Users/you/dev/infra", isDirectory: true, isGitRepo: true, gitBranch: "main" },
    {
      name: "design-system",
      path: "/Users/you/dev/design-system",
      isDirectory: true,
      isGitRepo: true,
      gitBranch: "release/3.2",
    },
    { name: "scratch", path: "/Users/you/dev/scratch", isDirectory: true, isGitRepo: false },
    { name: "notes.md", path: "/Users/you/dev/notes.md", isDirectory: false, isGitRepo: false },
  ],
});

// A small chart image (data URI) so the Files thumbnail renders something real.
const CHART = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160'><rect width='240' height='160' fill='#141416'/>` +
    [30, 70, 45, 95, 60, 120]
      .map(
        (h, i) =>
          `<rect x='${18 + i * 36}' y='${150 - h}' width='22' height='${h}' rx='3' fill='#f77a44' opacity='${0.5 + i * 0.08}'/>`,
      )
      .join("") +
    `<line x1='12' y1='150' x2='228' y2='150' stroke='#5c6370' stroke-width='1'/></svg>`,
)}`;
const FILES = [
  {
    id: "f1",
    name: "orders-latency.png",
    path: "/orders-latency.png",
    isImage: true,
    kind: "image" as const,
    mimeType: "image/png",
    size: 1_842_000,
    caption: "Latency before and after the cache fix",
    createdAt: Date.now() - 4 * 60_000,
    source: "received" as const,
    storage: "workspace" as const,
    available: true,
  },
  {
    id: "f3",
    name: "coverage.png",
    path: "/coverage.png",
    isImage: true,
    kind: "image" as const,
    mimeType: "image/png",
    size: 768_000,
    createdAt: Date.now() - 18 * 60_000,
    source: "received" as const,
    storage: "workspace" as const,
    available: true,
  },
  {
    id: "f4",
    name: "flamegraph.png",
    path: "/flamegraph.png",
    isImage: true,
    kind: "image" as const,
    mimeType: "image/png",
    size: 2_560_000,
    createdAt: Date.now() - 49 * 60_000,
    source: "received" as const,
    storage: "workspace" as const,
    available: true,
  },
  {
    id: "f2",
    name: "audit-report.md",
    path: "/audit.md",
    isImage: false,
    kind: "text" as const,
    mimeType: "text/markdown",
    size: 38_400,
    createdAt: Date.now() - 2 * 60_000,
    source: "sent" as const,
    storage: "managed" as const,
    available: true,
  },
  {
    id: "f5",
    name: "schema.sql",
    path: "/schema.sql",
    isImage: false,
    kind: "text" as const,
    mimeType: "text/plain",
    size: 14_700,
    createdAt: Date.now() - 21 * 60_000,
    source: "sent" as const,
    storage: "managed" as const,
    available: true,
  },
  {
    id: "f6",
    name: "large-export.csv",
    path: "",
    isImage: false,
    kind: "text" as const,
    mimeType: "text/csv",
    size: 8_200_000,
    createdAt: Date.now(),
    source: "sent" as const,
    storage: "managed" as const,
    uploading: true,
    progress: 0.64,
  },
];

function EditorScene() {
  const [file, setFile] = useState<File>();
  const [sent, setSent] = useState<File>();
  const [sentDimensions, setSentDimensions] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#111216";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f77a44";
    [220, 390, 310, 520, 440, 650].forEach((height, index) =>
      context.fillRect(100 + index * 170, 710 - height, 110, height),
    );
    context.fillStyle = "#f4f4f5";
    context.font = "600 54px Inter, sans-serif";
    context.fillText("Orders latency · last 24 hours", 90, 88);
    canvas.toBlob((blob) => {
      if (blob) setFile(new File([blob], "orders-latency.png", { type: "image/png" }));
    }, "image/png");
  }, []);
  useEffect(() => {
    if (!sent) return;
    let active = true;
    void createImageBitmap(sent).then((bitmap) => {
      if (active) setSentDimensions({ width: bitmap.width, height: bitmap.height });
      bitmap.close();
    });
    return () => {
      active = false;
    };
  }, [sent]);
  return file ? (
    <>
      <ImageEditorModal
        file={file}
        index={0}
        total={1}
        maxBytes={25 * 1024 * 1024}
        onCancel={() => {}}
        onSend={setSent}
      />
      {sent && (
        <output
          id="editor-smoke-result"
          data-size={sent.size}
          data-type={sent.type}
          data-width={sentDimensions?.width}
          data-height={sentDimensions?.height}
        />
      )}
    </>
  ) : (
    <div style={{ height: "100vh", background: "var(--bg)" }} />
  );
}

const terminal = (frame: string, session: SessionMeta = SESSION) => (
  <TerminalView
    session={session}
    createSocket={mockSocket(frame) as never}
    onShowSessions={() => {}}
    needsYou={1}
    onClose={() => {}}
  />
);

const list = (
  <SessionList
    sessions={SESSIONS}
    activeId={SESSIONS[0].id}
    order="created"
    lastActiveAt={{}}
    now={NOW}
    usage={USAGE}
    version={VERSION.current}
    onShowUpdate={() => {}}
    onCheckUpdate={async () => false}
    onOpenHelp={() => {}}
    onOpenSettings={() => {}}
    onSelect={() => {}}
    onNew={() => {}}
    onClose={() => {}}
  />
);

const mobileSessionShell = (content: ReactElement) => (
  <AppLayout
    navigation={productNavigation("sessions")}
    mobileNavigation={productNavigation("sessions", "bottom")}
    sessionList={list}
    sessionsOpen={false}
    conversationActive
    onHideSessions={() => {}}
  >
    {content}
  </AppLayout>
);

// Desktop split-screen scene: three REAL terminals in an iTerm2-style pane tree (left 55% + right column),
// each replaying a different captured TUI frame. All running (a dormant session would show the reconnect
// overlay); the left pane carries the focus ring.
const SPLIT_SESSIONS: SessionMeta[] = [
  { ...SESSION, awaiting: false, activity: "working" },
  { ...SESSIONS[1], status: "running", activity: "working", model: "sonnet", effort: "medium" },
  { ...SESSIONS[2], status: "running", activity: "idle", id: "s-infra" },
];
const SPLIT_FRAMES: Record<string, string> = {
  "s-orders": claudeDesktop,
  "s-web": claudeMobile,
  "s-infra": claudeStart,
};
const SPLIT_TREE = (() => {
  const a = makeLeaf("s-orders");
  const b = makeLeaf("s-web");
  const c = makeLeaf("s-infra");
  return { tree: splitLeaf(splitLeaf(a, a.id, "right", b), b.id, "bottom", c), focus: a.id };
})();

export const SCENES: Record<string, () => ReactElement> = {
  terminal: () => mobileSessionShell(terminal(claudeMobile)),
  codex: () => mobileSessionShell(terminal(codexMobile, CODEX_SESSION)),
  startup: () =>
    mobileSessionShell(
      <TerminalView
        session={SESSION}
        createSocket={mockSocket(claudeStart) as never}
        onShowSessions={() => {}}
        needsYou={0}
        onClose={() => {}}
      />,
    ),
  desktop: () => (
    <AppLayout
      navigation={productNavigation("sessions")}
      mobileNavigation={productNavigation("sessions", "bottom")}
      sessionList={list}
      sessionsOpen={false}
      conversationActive
      onHideSessions={() => {}}
    >
      {terminal(claudeDesktop)}
    </AppLayout>
  ),
  split: () => (
    <AppLayout
      navigation={productNavigation("sessions")}
      mobileNavigation={productNavigation("sessions", "bottom")}
      sessionList={list}
      sessionsOpen={false}
      conversationActive
      onHideSessions={() => {}}
    >
      <SplitWorkspace
        tree={SPLIT_TREE.tree}
        focusedLeafId={SPLIT_TREE.focus}
        sessions={SPLIT_SESSIONS}
        onFocusPane={() => {}}
        onTreeChange={() => {}}
        onPickSession={() => {}}
        onNewSessionInPane={() => {}}
        onClosePane={() => {}}
        renderTerminal={(s, pane) => (
          <TerminalView
            session={s}
            createSocket={mockSocket(SPLIT_FRAMES[s.id] ?? claudeMobile) as never}
            needsYou={0}
            onClose={() => {}}
            closeIsPane
            onSplitRight={() => {}}
            onSplitDown={() => {}}
            dragPaneId={pane.leafId}
          />
        )}
      />
    </AppLayout>
  ),
  sessions: () => <div style={{ height: "100vh", overflow: "auto", background: "var(--bg)" }}>{list}</div>,
  newsession: () => <DirectoryPicker listDir={listDir} recents={RECENTS} onPick={() => {}} onCancel={() => {}} />,
  files: () =>
    mobileSessionShell(
      <div style={{ position: "relative", height: "100%", background: "var(--bg)" }}>
        <TerminalFiles
          open
          files={FILES}
          onClose={() => {}}
          onUpload={() => {}}
          downloadUrl={(p) => (p.endsWith(".png") ? CHART : "#")}
        />
      </div>,
    ),
  editor: () => <EditorScene />,
  ota: () => (
    <div style={{ position: "relative", height: "100vh", background: "var(--bg)" }}>
      <UpdatePanel info={VERSION} state="idle" onUpdate={() => {}} onClose={() => {}} turnInProgress={false} />
    </div>
  ),
  login: () => <LoginScreen onAuthenticated={() => {}} />,
  agents: () => (
    <AppLayout
      navigation={productNavigation("agents")}
      mobileNavigation={productNavigation("agents", "bottom")}
      showSessionRail={false}
    >
      <AgentsPage client={AGENT_CLIENT} onStartSession={() => {}} onManageRuntime={() => {}} />
    </AppLayout>
  ),
  automations: () => (
    <AppLayout
      navigation={productNavigation("automations")}
      mobileNavigation={productNavigation("automations", "bottom")}
      showSessionRail={false}
    >
      <AutomationsPage client={AUTOMATION_CLIENT} onOpenSession={() => {}} />
    </AppLayout>
  ),
};
