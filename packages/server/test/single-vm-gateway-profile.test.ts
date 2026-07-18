import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repoRoot}${path}`, "utf8");

describe("provider-neutral single-VM gateway profile", () => {
  test("keeps relay secrets and both containers hardened", () => {
    const compose = read("packaging/relay/compose.yaml");
    const environment = read("packaging/relay/.env.example");
    const readme = read("packaging/relay/README.md");

    expect(compose).toContain("ROAMCODE_RELAY_ROOT_TOKEN_FILE");
    expect(compose).toContain(":/run/secrets/relay_root_token:ro");
    expect(compose).toContain(":/run/secrets/previous_root_tokens:ro");
    expect(compose).not.toMatch(/^secrets:/mu);
    expect(compose).toContain('user: "10001:10001"');
    expect(compose).toContain('user: "10002:10002"');
    expect(compose.match(/^\s+read_only: true$/gmu)).toHaveLength(2);
    expect(compose.match(/^\s+pids_limit: /gmu)).toHaveLength(2);
    expect(compose.match(/^\s+mem_limit: /gmu)).toHaveLength(2);
    expect(compose.match(/^\s+driver: local$/gmu)).toHaveLength(2);
    expect(environment).toContain("relay-root-token.container");
    expect(readme).toContain("sudo install -o 10001 -g 10001 -m 0400");
  });

  test("serves one canonical origin and keeps private routes private", () => {
    const caddy = read("packaging/relay/Caddyfile");
    const compose = read("packaging/relay/compose.yaml");
    const environment = read("packaging/relay/.env.example");

    expect(caddy).toContain("{$ROAMCODE_DOMAIN}");
    expect(caddy).toContain("{$ROAMCODE_API_UPSTREAM:api:4400}");
    expect(caddy).toContain("{$ROAMCODE_RELAY_UPSTREAM:relay:4281}");
    expect(caddy).toContain("header_up -Forwarded");
    expect(caddy).not.toContain("header_up -X-Forwarded-For");
    expect(caddy).not.toContain("header_up -X-Forwarded-Host");
    expect(caddy).not.toContain("header_up -X-Forwarded-Port");
    expect(caddy).not.toContain("header_up -X-Forwarded-Proto");
    expect(caddy).not.toContain("header_up -X-Real-IP");
    expect(caddy).toContain("header_up X-Forwarded-For {remote_host}");
    expect(caddy).toContain("header_up X-Forwarded-Host {host}");
    expect(caddy).toContain("header_up X-Forwarded-Port {http.request.local.port}");
    expect(caddy).toContain("header_up X-Forwarded-Proto {scheme}");
    expect(caddy).toContain("header_up X-Real-IP {remote_host}");
    expect(caddy).toContain("path /api /api/* /internal /internal/* /v1 /v1/*");
    expect(caddy).toContain(":8080 {");
    expect(caddy).toContain("respond /healthz 200");
    expect(compose).toContain("http://127.0.0.1:8080/healthz");
    expect(environment).toContain("ROAMCODE_DOMAIN=roamcode.example.com");
    expect(environment).not.toContain("ROAMCODE_APP_DOMAIN");
    expect(environment).not.toContain("ROAMCODE_RELAY_DOMAIN");
  });

  test("builds the complete site and unchanged terminal PWA into a pinned non-root image", () => {
    const dockerfile = read("packaging/relay/Edge.Dockerfile");

    expect(dockerfile).toMatch(/node:24\.18\.0-bookworm-slim@sha256:[0-9a-f]{64}/u);
    expect(dockerfile.match(/caddy:2\.10\.2-alpine@sha256:[0-9a-f]{64}/gu)).toHaveLength(2);
    expect(dockerfile).toContain("RUN pnpm --dir site build");
    expect(dockerfile).toContain("COPY --from=build /src/site/dist /srv");
    expect(dockerfile).toContain("USER 10002:10002");
  });
});
