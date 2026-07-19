import { describe, expect, test } from "vitest";
import {
  agentRuntimeId,
  ownerFromProductContext,
  productContextFromOwner,
  projectAgentRuntimeRecords,
  projectNodeRecord,
} from "../src/node-domain.js";

describe("node domain projections", () => {
  test("maps owners and product contexts without changing canonical identity", () => {
    const personal = productContextFromOwner({ type: "person", id: "person_1" }, "Burak");
    const organization = productContextFromOwner({ type: "organization", id: "org_1" }, "RoamCode");

    expect(personal).toEqual({ kind: "personal", id: "person_1", name: "Burak" });
    expect(organization).toEqual({ kind: "organization", id: "org_1", name: "RoamCode" });
    expect(ownerFromProductContext(personal)).toEqual({ type: "person", id: "person_1" });
    expect(ownerFromProductContext(organization)).toEqual({ type: "organization", id: "org_1" });
  });

  test("keeps the persistent host id and projects owner and deduplicated aliases", () => {
    const node = projectNodeRecord({
      host: { id: "host_persistent", label: "Build Mac" },
      owner: { type: "organization", id: "org_1" },
      status: "degraded",
      platform: "darwin-arm64",
      lastSeenAt: 42,
      aliases: [
        { kind: "peer-host", id: "peer_1" },
        { kind: "command-host", id: "host_persistent" },
        { kind: "direct-host", id: "browser-route" },
        { kind: "peer-host", id: "peer_1" },
      ],
    });

    expect(node).toEqual({
      id: "host_persistent",
      owner: { type: "organization", id: "org_1" },
      name: "Build Mac",
      status: "degraded",
      platform: "darwin-arm64",
      lastSeenAt: 42,
      aliases: [
        { kind: "command-host", id: "host_persistent" },
        { kind: "peer-host", id: "peer_1" },
        { kind: "direct-host", id: "browser-route" },
      ],
    });
  });
});

describe("agent runtime projections", () => {
  test("generates deterministic route-safe ids scoped to both node and provider", () => {
    const first = agentRuntimeId("node one/with spaces", "codex");
    expect(agentRuntimeId("node one/with spaces", "codex")).toBe(first);
    expect(first).toMatch(/^runtime_[A-Za-z0-9_-]{24}$/);
    expect(agentRuntimeId("node-two", "codex")).not.toBe(first);
    expect(agentRuntimeId("node one/with spaces", "claude")).not.toBe(first);
  });

  test("projects availability, auth, versions, capabilities, and active session counts", () => {
    const runtimes = projectAgentRuntimeRecords({
      nodeId: "node_1",
      descriptors: [
        {
          id: "codex",
          displayName: "Codex",
          version: "1.0.0-adapter",
          enabled: true,
          capabilities: { launch: true, resume: true, usage: false, login: true },
        },
        {
          id: "claude",
          displayName: "Claude Code",
          version: "2.0.0-adapter",
          enabled: false,
          capabilities: { launch: true, resume: false },
        },
      ],
      availabilityByProvider: new Map([
        ["codex", { terminalAvailable: true, metadataAvailable: true, version: "0.72.0" }],
        ["claude", { terminalAvailable: true, metadataAvailable: true }],
      ]),
      authStateByProvider: { codex: "ready", claude: "required" },
      activeSessionCountByProvider: { codex: 3, claude: 1 },
      additionalCapabilitiesByProvider: { codex: ["task-bootstrap", "login"], claude: ["task-bootstrap"] },
      observedAt: 100,
    });

    expect(runtimes).toEqual([
      {
        id: agentRuntimeId("node_1", "codex"),
        nodeId: "node_1",
        provider: "codex",
        displayName: "Codex",
        availability: "available",
        authState: "ready",
        version: "0.72.0",
        capabilities: ["launch", "login", "resume", "task-bootstrap"],
        activeSessionCount: 3,
        observedAt: 100,
      },
      {
        id: agentRuntimeId("node_1", "claude"),
        nodeId: "node_1",
        provider: "claude",
        displayName: "Claude Code",
        availability: "unavailable",
        authState: "required",
        version: "2.0.0-adapter",
        capabilities: ["launch", "task-bootstrap"],
        activeSessionCount: 1,
        observedAt: 100,
      },
    ]);
  });

  test("defaults missing observations safely and never exposes probe detail or arbitrary private fields", () => {
    const descriptor = {
      id: "codex",
      displayName: "Codex",
      capabilities: { launch: true },
      optionSchema: { cwd: "/private/project", token: "descriptor-secret" },
      secret: "descriptor-secret",
    };
    const availability = {
      terminalAvailable: false,
      metadataAvailable: false,
      detail: "/private/bin/codex --token probe-secret",
      cwd: "/private/project",
      secret: "probe-secret",
    };
    const [runtime] = projectAgentRuntimeRecords({
      nodeId: "node_1",
      descriptors: [descriptor],
      availabilityByProvider: { codex: availability },
      activeSessionCountByProvider: { codex: -1 },
      observedAt: 200,
    });

    expect(runtime).toEqual({
      id: agentRuntimeId("node_1", "codex"),
      nodeId: "node_1",
      provider: "codex",
      displayName: "Codex",
      availability: "unavailable",
      authState: "unknown",
      capabilities: ["launch"],
      activeSessionCount: 0,
      observedAt: 200,
    });
    expect(JSON.stringify(runtime)).not.toMatch(/private|secret|token|detail|cwd/i);
  });
});
