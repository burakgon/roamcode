import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { test, vi } from "vitest";

import worker, { type Env } from "./index.ts";

const secret = "edge-hmac-secret-with-at-least-thirty-two-characters";
const keyId = "edge-2026-07";
const context = { waitUntil: () => undefined };

function assets(): Env["ASSETS"] {
  return { fetch: async () => new Response("asset") };
}

test("account proxy replaces browser forwarding metadata with an authenticated IPv4", async () => {
  let forwarded: Request | undefined;
  const env: Env = {
    ASSETS: assets(),
    CONTROL_PLANE: {
      fetch: async (request) => {
        forwarded = request;
        return new Response(null, { status: 204 });
      },
    },
    CONTROL_PLANE_EDGE_AUTH_KEY_ID: keyId,
    CONTROL_PLANE_EDGE_AUTH_SECRET: secret,
  };
  const response = await worker.fetch(
    new Request("https://roamcode.ai/api/v1/contexts?kind=all", {
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        forwarded: "for=198.51.100.1",
        "true-client-ip": "198.51.100.2",
        "x-forwarded-for": "198.51.100.3",
        "x-real-ip": "198.51.100.4",
        "x-roamcode-client-ip": "198.51.100.5",
        "x-roamcode-edge-client-ip": "198.51.100.6",
        "x-roamcode-edge-key-id": "attacker",
        "x-roamcode-edge-signature": "A".repeat(43),
        "x-roamcode-edge-timestamp": "1",
      },
    }),
    env,
    context,
  );
  assert.equal(response.status, 204);
  assert.ok(forwarded);
  assert.equal(forwarded.headers.get("cf-connecting-ip"), null);
  assert.equal(forwarded.headers.get("forwarded"), null);
  assert.equal(forwarded.headers.get("true-client-ip"), null);
  assert.equal(forwarded.headers.get("x-forwarded-for"), null);
  assert.equal(forwarded.headers.get("x-real-ip"), null);
  assert.equal(forwarded.headers.get("x-roamcode-client-ip"), null);
  assert.equal(forwarded.headers.get("x-roamcode-edge-client-ip"), "203.0.113.9");
  assert.equal(forwarded.headers.get("x-roamcode-edge-key-id"), keyId);

  const timestamp = forwarded.headers.get("x-roamcode-edge-timestamp");
  assert.match(timestamp ?? "", /^[0-9]{10}$/);
  const expected = createHmac("sha256", secret)
    .update(["roamcode-edge-client-ip-v1", timestamp, "GET", "/api/v1/contexts?kind=all", "203.0.113.9"].join("\n"))
    .digest("base64url");
  assert.equal(forwarded.headers.get("x-roamcode-edge-signature"), expected);
});

test("account proxy signs a valid IPv6 address", async () => {
  let forwarded: Request | undefined;
  const response = await worker.fetch(
    new Request("https://roamcode.ai/api/auth/get-session", {
      headers: { "cf-connecting-ip": "2001:db8:85a3::8a2e:370:7334" },
    }),
    {
      ASSETS: assets(),
      CONTROL_PLANE: {
        fetch: async (request) => {
          forwarded = request;
          return Response.json({ ok: true });
        },
      },
      CONTROL_PLANE_EDGE_AUTH_KEY_ID: keyId,
      CONTROL_PLANE_EDGE_AUTH_SECRET: secret,
    },
    context,
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded?.headers.get("x-roamcode-edge-client-ip"), "2001:db8:85a3::8a2e:370:7334");
});

test("account proxy fails closed for missing secrets or malformed client IPs", async () => {
  let calls = 0;
  const controlPlane = {
    fetch: async () => {
      calls += 1;
      return Response.json({ ok: true });
    },
  };
  for (const input of [
    {
      ip: "999.0.0.1",
      key: keyId,
      configuredSecret: secret,
    },
    {
      ip: "2001:db8:::1",
      key: keyId,
      configuredSecret: secret,
    },
    {
      ip: "203.0.113.9",
      key: "",
      configuredSecret: secret,
    },
    {
      ip: "203.0.113.9",
      key: keyId,
      configuredSecret: "",
    },
  ]) {
    const response = await worker.fetch(
      new Request("https://roamcode.ai/api/v1/contexts", {
        headers: { "cf-connecting-ip": input.ip },
      }),
      {
        ASSETS: assets(),
        CONTROL_PLANE: controlPlane,
        CONTROL_PLANE_EDGE_AUTH_KEY_ID: input.key,
        CONTROL_PLANE_EDGE_AUTH_SECRET: input.configuredSecret,
      },
      context,
    );
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /hmac|secret|signature/i);
  }
  assert.equal(calls, 0);
});

test("origin and HMAC bindings fail closed before a public control-plane fetch", async () => {
  const networkFetch = vi.fn(async () => Response.json({ must_not: "be reached" }));
  vi.stubGlobal("fetch", networkFetch);
  try {
    for (const configured of [
      {
        origin: undefined,
        key: keyId,
        configuredSecret: secret,
      },
      {
        origin: "http://control.example.test",
        key: keyId,
        configuredSecret: secret,
      },
      {
        origin: "https://staging.roamcode.ai",
        key: keyId,
        configuredSecret: secret,
      },
      {
        origin: "https://control.example.test/private-path",
        key: keyId,
        configuredSecret: secret,
      },
      {
        origin: "https://control.example.test",
        key: "",
        configuredSecret: secret,
      },
      {
        origin: "https://control.example.test",
        key: keyId,
        configuredSecret: "short",
      },
    ]) {
      const response = await worker.fetch(
        new Request("https://staging.roamcode.ai/api/v1/meta/product-capabilities", {
          headers: { "cf-connecting-ip": "203.0.113.9" },
        }),
        {
          ASSETS: assets(),
          CONTROL_PLANE_ORIGIN: configured.origin,
          CONTROL_PLANE_EDGE_AUTH_KEY_ID: configured.key,
          CONTROL_PLANE_EDGE_AUTH_SECRET: configured.configuredSecret,
        },
        context,
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.text();
      assert.match(body, /cloud_unavailable/u);
      assert.doesNotMatch(body, /hmac|secret|signature/i);
    }
    assert.equal(networkFetch.mock.calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("account shell strips link secrets before the asset lookup and disables referrers", async () => {
  let assetRequest: Request | undefined;
  const response = await worker.fetch(
    new Request("https://roamcode.ai/app/reset-password?token=private-reset-token&campaign=email", {
      headers: { "if-none-match": '"stale-shell"', range: "bytes=0-20" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          assetRequest = request;
          return new Response(
            '<!doctype html><title>Account</title><script>window.__boot=true</script><script src="/assets/app.js"></script>',
            {
              headers: {
                "content-type": "text/html; charset=utf-8",
                etag: '"stale-shell"',
                "accept-ranges": "bytes",
              },
            },
          );
        },
      },
    },
    context,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
  const csp = response.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'self' 'nonce-([^']+)'/u.exec(csp)?.[1];
  assert.ok(nonce);
  const html = await response.text();
  assert.ok(html.includes(`<script nonce="${nonce}">window.__boot=true</script>`));
  assert.ok(html.includes('<script src="/assets/app.js"></script>'));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/u);
  assert.equal(assetRequest?.url, "https://roamcode.ai/");
  assert.equal(assetRequest?.headers.get("if-none-match"), null);
  assert.equal(assetRequest?.headers.get("range"), null);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("accept-ranges"), null);
  assert.doesNotMatch(assetRequest?.url ?? "", /private-reset-token/);
});

test("legacy app origin redirects only safe navigations to the canonical account entry", async () => {
  let assetCalls = 0;
  const env: Env = {
    ASSETS: {
      fetch: async () => {
        assetCalls += 1;
        return new Response("asset");
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://app.roamcode.ai/private/path?token=must-not-forward"),
    env,
    context,
  );
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://roamcode.ai/app");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.doesNotMatch(response.headers.get("location") ?? "", /token|private/u);

  const mutation = await worker.fetch(
    new Request("https://app.roamcode.ai/api/auth/sign-out", { method: "POST" }),
    env,
    context,
  );
  assert.equal(mutation.status, 421);
  assert.equal(mutation.headers.get("location"), null);
  assert.equal(assetCalls, 0);
});

test("project-owned source links redirect without exposing navigation query data", async () => {
  let assetCalls = 0;
  const env: Env = {
    ASSETS: {
      fetch: async () => {
        assetCalls += 1;
        return new Response("asset");
      },
    },
  };
  for (const [pathname, expectedSuffix] of [
    ["/source", "/roamcode"],
    ["/source/license", "/roamcode/blob/main/LICENSE"],
    ["/source/security", "/roamcode/security"],
    ["/source/security-policy", "/roamcode/blob/main/SECURITY.md"],
    ["/source/discussions", "/roamcode/discussions"],
  ]) {
    const response = await worker.fetch(
      new Request(`https://roamcode.ai${pathname}?token=must-not-forward`),
      env,
      context,
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.hostname, "github.com");
    assert.ok(location.pathname.endsWith(expectedSuffix));
    assert.equal(location.search, "");
  }

  const mutation = await worker.fetch(
    new Request("https://roamcode.ai/source/security", { method: "POST" }),
    env,
    context,
  );
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get("allow"), "GET, HEAD");
  assert.equal(assetCalls, 0);
});

test("public legal, security, contact, and subprocessor routes are complete cacheable documents", async () => {
  let assetCalls = 0;
  const env: Env = {
    ASSETS: {
      fetch: async () => {
        assetCalls += 1;
        return new Response("asset");
      },
    },
  };
  for (const pathname of [
    "/legal/terms",
    "/legal/privacy/",
    "/legal/acceptable-use",
    "/legal/dpa",
    "/legal/subprocessors",
    "/security",
    "/contact",
  ]) {
    const response = await worker.fetch(new Request(`https://roamcode.ai${pathname}`), env, context);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("x-robots-tag"), "index, follow");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("cache-control") ?? "", /public, max-age=300, s-maxage=3600/u);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    const html = await response.text();
    assert.match(html, /<!doctype html>/iu);
    assert.match(html, /<h1>/u);
    assert.match(html, /MIT License/u);
  }
  assert.equal(assetCalls, 0);

  const head = await worker.fetch(new Request("https://roamcode.ai/legal/privacy", { method: "HEAD" }), env, context);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const mutation = await worker.fetch(new Request("https://roamcode.ai/legal/terms", { method: "POST" }), env, context);
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get("allow"), "GET, HEAD");
});

test("account routing serves only named product paths and leaves unknown URLs to static 404 handling", async () => {
  const assetRequests: string[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (request) => {
        assetRequests.push(request.url);
        return new Response(new URL(request.url).pathname, { status: 404 });
      },
    },
  };

  const known = await worker.fetch(new Request("https://roamcode.ai/app/agents/?context=org-1"), env, context);
  assert.equal(known.status, 404);
  assert.equal(assetRequests.at(-1), "https://roamcode.ai/");

  const unknown = await worker.fetch(new Request("https://roamcode.ai/app/projects"), env, context);
  assert.equal(unknown.status, 404);
  assert.equal(assetRequests.at(-1), "https://roamcode.ai/app/projects");
});

test("terminal product navigations serve one secured PWA shell", async () => {
  const assetRequests: Request[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (request) => {
        assetRequests.push(request);
        return new Response("terminal-shell<script>window.__terminal=true</script>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  };
  for (const pathname of [
    "/terminal",
    "/terminal/",
    "/terminal/sessions?enroll=00000000-0000-4000-8000-000000000001",
    "/terminal/automations",
    "/terminal/agents/",
  ]) {
    const response = await worker.fetch(new Request(`https://roamcode.ai${pathname}`), env, context);
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'self' 'nonce-([^']+)'/u.exec(csp)?.[1];
    assert.ok(nonce);
    assert.equal(await response.text(), `terminal-shell<script nonce="${nonce}">window.__terminal=true</script>`);
    assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.match(csp, /default-src 'self'/u);
    assert.match(csp, /connect-src 'self' https: wss:/u);
  }
  assert.deepEqual(
    assetRequests.map((request) => request.url),
    Array.from({ length: 5 }, () => "https://roamcode.ai/terminal/"),
  );

  const head = await worker.fetch(
    new Request("https://roamcode.ai/terminal/sessions", { method: "HEAD" }),
    env,
    context,
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("terminal assets and Node API-shaped paths bypass the control-plane proxy", async () => {
  const assetRequests: string[] = [];
  let controlPlaneCalls = 0;
  const env: Env = {
    ASSETS: {
      fetch: async (request) => {
        assetRequests.push(request.url);
        return new Response(new URL(request.url).pathname, {
          headers: { "cache-control": "public, max-age=31536000, immutable" },
        });
      },
    },
    CONTROL_PLANE: {
      fetch: async () => {
        controlPlaneCalls += 1;
        return Response.json({ proxied: true });
      },
    },
  };
  for (const pathname of [
    "/terminal/assets/app.js?build=one",
    "/terminal/manifest.webmanifest",
    "/terminal/sw.js",
    "/terminal/api/v2/context",
    "/terminal/api/v1/sessions",
    "/api/v2/nodes",
  ]) {
    const response = await worker.fetch(new Request(`https://roamcode.ai${pathname}`), env, context);
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  }
  assert.equal(controlPlaneCalls, 0);
  assert.deepEqual(assetRequests, [
    "https://roamcode.ai/terminal/assets/app.js?build=one",
    "https://roamcode.ai/terminal/manifest.webmanifest",
    "https://roamcode.ai/terminal/sw.js",
    "https://roamcode.ai/terminal/api/v2/context",
    "https://roamcode.ai/terminal/api/v1/sessions",
    "https://roamcode.ai/api/v2/nodes",
  ]);
});

test("the static entry installs no-referrer and token scrubbing before any subresource", () => {
  const html = readFileSync("index.html", "utf8");
  const referrer = html.indexOf('<meta name="referrer" content="no-referrer"');
  const scrubber = html.indexOf("const accountPath =");
  const firstSubresource = html.indexOf('<link rel="canonical"');
  const moduleEntry = html.indexOf('<script type="module"');

  assert.ok(referrer > 0);
  assert.ok(scrubber > referrer);
  assert.ok(firstSubresource > scrubber);
  assert.ok(moduleEntry > scrubber);
});
