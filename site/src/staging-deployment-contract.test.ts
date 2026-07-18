// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertStagingConfig,
  missingRequiredSecrets,
  REQUIRED_STAGING_SECRETS,
  stagingDeployArguments,
  validateCapabilityDocument,
} from "../scripts/staging-deploy.mjs";

const siteDirectory = process.cwd();

function readStrictJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readProductionConfig(): Record<string, unknown> {
  const source = readFileSync(join(siteDirectory, "wrangler.jsonc"), "utf8");
  return JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as Record<string, unknown>;
}

const closedCapabilityDocument = {
  v: 1,
  launch: { account: false, managedTerminal: false },
  capabilities: [],
  requiredNodeCapabilities: [],
};

describe("staging deployment contract", () => {
  test("uses an isolated Worker, Custom Domain, bindings, and secret declaration", () => {
    const staging = readStrictJson(join(siteDirectory, "wrangler.staging.jsonc"));
    const production = readProductionConfig();

    expect(() => assertStagingConfig(staging)).not.toThrow();
    expect(staging.name).toBe("roamcode-site-staging");
    expect(staging.name).not.toBe(production.name);
    expect(staging.routes).toEqual([{ pattern: "staging.roamcode.ai", custom_domain: true }]);
    expect(production.routes).toEqual([
      { pattern: "roamcode.ai", custom_domain: true },
      { pattern: "app.roamcode.ai", custom_domain: true },
    ]);
    expect(staging).not.toHaveProperty("env");
    expect(staging).not.toHaveProperty("vars");
    expect(staging).not.toHaveProperty("services");
    expect(staging).not.toHaveProperty("keep_vars");
    expect(staging.secrets).toEqual({ required: REQUIRED_STAGING_SECRETS });
    expect(Object.keys(staging.assets as object)).toEqual(["directory", "binding", "run_worker_first"]);
  });

  test("rejects production routing or unreviewed staging bindings", () => {
    const staging = readStrictJson(join(siteDirectory, "wrangler.staging.jsonc"));
    expect(() =>
      assertStagingConfig({
        ...staging,
        routes: [...(staging.routes as object[]), { pattern: "roamcode.ai", custom_domain: true }],
      }),
    ).toThrow(/route/iu);
    expect(() => assertStagingConfig({ ...staging, keep_vars: true })).toThrow(/top-level/iu);
    expect(() =>
      assertStagingConfig({ ...staging, services: [{ binding: "CONTROL_PLANE", service: "production" }] }),
    ).toThrow(/top-level/iu);
  });

  test("requires all three staging secret names without accepting values", () => {
    expect(
      missingRequiredSecrets([
        { name: "CONTROL_PLANE_ORIGIN", type: "secret_text" },
        { name: "CONTROL_PLANE_EDGE_AUTH_SECRET", type: "secret_text" },
      ]),
    ).toEqual(["CONTROL_PLANE_EDGE_AUTH_KEY_ID"]);
    expect(missingRequiredSecrets([...REQUIRED_STAGING_SECRETS])).toEqual([]);
    expect(() => missingRequiredSecrets([{ value: "must-not-be-accepted" }])).toThrow(/invalid secret inventory/iu);
  });

  test("accepts closed gates and only opens gates backed by the exact v1 contract", () => {
    expect(validateCapabilityDocument(closedCapabilityDocument)).toEqual({ account: false, managedTerminal: false });
    expect(
      validateCapabilityDocument({
        ...closedCapabilityDocument,
        launch: { account: true, managedTerminal: false },
        capabilities: ["account.v1"],
      }),
    ).toEqual({ account: true, managedTerminal: false });
    expect(
      validateCapabilityDocument({
        v: 1,
        launch: { account: true, managedTerminal: true },
        capabilities: ["account.v1", "managed-device-enrollment.v1"],
        requiredNodeCapabilities: ["managed-device-enrollment.v1", "terminal.v1", "relay.v1"],
      }),
    ).toEqual({ account: true, managedTerminal: true });
  });

  test.each([
    ["future version", { ...closedCapabilityDocument, v: 2 }],
    ["malformed launch", { ...closedCapabilityDocument, launch: { account: "yes", managedTerminal: false } }],
    ["account capability mismatch", { ...closedCapabilityDocument, launch: { account: true, managedTerminal: false } }],
    [
      "managed launch without account",
      {
        ...closedCapabilityDocument,
        launch: { account: false, managedTerminal: true },
        capabilities: ["managed-device-enrollment.v1"],
      },
    ],
    [
      "managed launch without its product capability",
      {
        ...closedCapabilityDocument,
        launch: { account: true, managedTerminal: true },
        capabilities: ["account.v1"],
        requiredNodeCapabilities: ["terminal.v1", "relay.v1", "managed-device-enrollment.v1"],
      },
    ],
    [
      "managed launch with incomplete Node requirements",
      {
        ...closedCapabilityDocument,
        launch: { account: true, managedTerminal: true },
        capabilities: ["account.v1", "managed-device-enrollment.v1"],
        requiredNodeCapabilities: ["terminal.v1", "relay.v1"],
      },
    ],
  ])("rejects %s", (_name, document) => {
    expect(() => validateCapabilityDocument(document)).toThrow();
  });

  test("keeps default production deployment commands separate from staging automation", () => {
    const packageManifest = readStrictJson(join(siteDirectory, "package.json"));
    const scripts = packageManifest.scripts as Record<string, string>;
    expect(scripts.deploy).toBe("wrangler deploy");
    expect(scripts["staging:check"]).toBe("node scripts/staging-deploy.mjs check");
    expect(scripts["deploy:staging"]).toBe("node scripts/staging-deploy.mjs deploy");
    expect(scripts["bootstrap:staging"]).toBe("node scripts/staging-deploy.mjs bootstrap");

    expect(stagingDeployArguments()).toEqual([
      "deploy",
      "--config",
      "wrangler.staging.jsonc",
      "--strict",
      "--autoconfig=false",
    ]);
    expect(stagingDeployArguments("/outside/repository/staging-secrets")).toEqual([
      ...stagingDeployArguments(),
      "--secrets-file",
      "/outside/repository/staging-secrets",
    ]);

    const wrapper = readFileSync(join(siteDirectory, "scripts", "staging-deploy.mjs"), "utf8");
    expect(wrapper).toContain('const stagingConfigFilename = "wrangler.staging.jsonc"');
    expect(wrapper).not.toContain('"wrangler.jsonc"');
    expect(wrapper).not.toContain(".production-deploy-hold");
  });
});
