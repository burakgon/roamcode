import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repoRoot}${path}`, "utf8");

describe("GCP Cloudflare Tunnel deployment profile", () => {
  test("ships operational shell entrypoints as executable files", () => {
    for (const script of [
      "backup.sh",
      "bootstrap.sh",
      "configure-monitoring.sh",
      "fetch-secrets.sh",
      "healthcheck.sh",
      "restore-check.sh",
      "verify-public-wss.sh",
      "verify-public.sh",
      "verify.sh",
    ]) {
      expect(statSync(`${repoRoot}packaging/relay/gcp/${script}`).mode & 0o111).toBe(0o111);
    }
  });

  test("keeps the portable Compose secret readable only by the non-root relay user", () => {
    const compose = read("packaging/relay/compose.yaml");
    const environment = read("packaging/relay/.env.example");
    const readme = read("packaging/relay/README.md");

    expect(compose).toContain("ROAMCODE_RELAY_ROOT_TOKEN_FILE");
    expect(compose).toContain(":/run/secrets/relay_root_token:ro");
    expect(compose).toContain("ROAMCODE_RELAY_PREVIOUS_ROOT_TOKEN_DIR");
    expect(compose).toContain(":/run/secrets/previous_root_tokens:ro");
    expect(compose).not.toContain("ROAMCODE_RELAY_PREVIOUS_ROOT_TOKENS:");
    expect(compose).not.toMatch(/^secrets:/m);
    expect(compose).toContain('user: "10001:10001"');
    expect(compose).toContain('user: "10002:10002"');
    expect(compose.match(/^\s+read_only: true$/gm)).toHaveLength(2);
    expect(compose.match(/^\s+pids_limit: /gm)).toHaveLength(2);
    expect(compose.match(/^\s+mem_limit: /gm)).toHaveLength(2);
    expect(compose.match(/^\s+driver: local$/gm)).toHaveLength(2);
    expect(environment).toContain("relay-root-token.container");
    expect(environment).toContain("previous-root-tokens");
    expect(readme).toContain("sudo install -o 10001 -g 10001 -m 0400");
    expect(readme).toContain("relay-root-token.operator");
  });

  test("requires reviewed image digests and never publishes an origin port", () => {
    const environment = read("packaging/relay/gcp/cloud.env.example");
    const compose = read("packaging/relay/gcp/compose.yaml");
    const fetchSecrets = read("packaging/relay/gcp/fetch-secrets.sh");

    expect(
      environment.match(/^ROAMCODE_(?:RELAY|EDGE)_IMAGE=\S+@sha256:REPLACE_WITH_RELEASE_MANIFEST_DIGEST$/gm),
    ).toHaveLength(2);
    expect(environment).toMatch(/^CLOUDFLARED_IMAGE=\S+@sha256:[0-9a-f]{64}$/m);
    expect(fetchSecrets).toContain("Every cloud image must be pinned by sha256 digest");
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toContain("internal: true");
    expect(compose).toContain("--token-file");
    expect(compose).not.toContain("ROAMCODE_TUNNEL_TOKEN:");
    expect(compose).not.toContain("ROAMCODE_RELAY_PREVIOUS_ROOT_TOKENS:");
    expect(compose).toContain("/run/secrets/previous-root-tokens:ro");
    expect(compose).toContain("ROAMCODE_RELAY_MAX_TOTAL_CONNECTIONS:");
  });

  test("runs every container as a bounded, read-only, non-root process", () => {
    const compose = read("packaging/relay/gcp/compose.yaml");
    const edgeImage = read("packaging/relay/Edge.Dockerfile");

    for (const user of ["10001:10001", "10002:10002", "65532:65532"]) {
      expect(compose).toContain(`user: "${user}"`);
    }
    expect(edgeImage).toContain("USER 10002:10002");
    expect(compose.match(/^\s+read_only: true$/gm)).toHaveLength(3);
    expect(compose.match(/^\s+- no-new-privileges:true$/gm)).toHaveLength(3);
    expect(compose.match(/^\s+pids_limit: /gm)).toHaveLength(3);
    expect(compose.match(/^\s+mem_limit: /gm)).toHaveLength(3);
    expect(compose.match(/^\s+driver: local$/gm)).toHaveLength(3);
  });

  test("fetches capabilities into owned files without putting bearer values in argv", () => {
    const fetchSecrets = read("packaging/relay/gcp/fetch-secrets.sh");

    expect(fetchSecrets).toContain("Metadata-Flavor: Google");
    expect(fetchSecrets).toContain("versions/latest:access");
    expect(fetchSecrets).toContain("curl --config -");
    expect(fetchSecrets).not.toMatch(/curl[^\n]+-H ["']Authorization:/);
    expect(fetchSecrets).toContain('chmod 400 "$temporary"');
    expect(fetchSecrets).toContain('mv -f "$temporary" "$destination"');
    expect(fetchSecrets).toContain('sync -f "$destination"');
    expect(fetchSecrets).toContain('"$SECRETS_DIR/previous-root-tokens"');
  });

  test("requires the persistent disk and recreates containers after secret refresh", () => {
    const bootstrap = read("packaging/relay/gcp/bootstrap.sh");
    const service = read("packaging/relay/gcp/roamcode-cloud.service");

    expect(bootstrap).toContain("Mount the dedicated RoamCode data disk");
    expect(service).toContain("RequiresMountsFor=/var/lib/roamcode-cloud");
    expect(service).toContain("ProtectSystem=strict");
    expect(service.match(/--force-recreate/g)).toHaveLength(2);
    expect(service.match(/pull --policy missing --quiet/g)).toHaveLength(2);
    expect(service).toContain("compose.yaml config --quiet");
    expect(bootstrap).toContain("verify-public.sh");
  });

  test("defines idempotent regional uptime checks and alert policies", () => {
    const monitoring = read("packaging/relay/gcp/configure-monitoring.sh");

    expect(monitoring).toContain("gcloud monitoring uptime create");
    expect(monitoring).toContain("--validate-ssl=true");
    expect(monitoring).toContain("--regions=europe,usa-oregon,asia-pacific");
    expect(monitoring).toContain("gcloud monitoring policies create");
    expect(monitoring).toContain("--duration=120s");
    expect(monitoring).toContain("--trigger-percent=50");
    expect(monitoring).toContain("exact_regions");
    expect(monitoring).toContain("exact_http");
    expect(monitoring).toContain("exact_policy");
    expect(monitoring).toContain("MATCHES_JSON_PATH");
    expect(monitoring).toContain("ALIGN_NEXT_OLDER");
    expect(monitoring).not.toContain("--notification-channels");
  });

  test("fails deployment verification when public HTTP or response policy is unsafe", () => {
    const caddy = read("packaging/relay/Caddyfile");
    const publicVerification = read("packaging/relay/gcp/verify-public.sh");

    expect(caddy.match(/X-Forwarded-Proto http/g)).toHaveLength(2);
    expect(caddy.match(/redir @forwardedHttp https:\/\/{host\}{uri} 308/g)).toHaveLength(2);
    expect(caddy).toContain("@assetRequest path /assets/*");
    expect(caddy).toContain("@fileRequest path_regexp");
    expect(caddy).not.toContain("[::1]:*");
    expect(caddy).toContain("handle @assetRequest");
    expect(caddy).toContain("handle @fileRequest");
    expect(caddy).toMatch(/@immutable \{\s+path \/assets\/\*\s+file\s+\}/);
    expect(caddy).toMatch(/@missingAsset \{\s+path \/assets\/\*\s+not file\s+\}/);
    expect(publicVerification.match(/^assert_redirect /gm)).toHaveLength(2);
    expect(publicVerification).toContain('if [ "$code" != 308 ]');
    expect(publicVerification).toContain('probe="$(date -u +%s)-$$"');
    expect(publicVerification).toContain("content-security-policy");
    expect(publicVerification).toContain("strict-transport-security");
    expect(publicVerification).toContain("cache-control");
    expect(publicVerification).toContain("x-content-type-options");
    expect(publicVerification).toContain("not-a-relay-route");
    expect(publicVerification).toContain("/workspaces");
    expect(publicVerification).toContain("/assets/roamcode-missing-smoke.js");
    expect(publicVerification).toContain("/roamcode-missing-smoke.css");
    expect(publicVerification).toContain('require_header_contains "$missing_asset_headers" cache-control no-store');
  });

  test("proves public WebSocket upgrades with a transient route and guaranteed cleanup", () => {
    const wrapper = read("packaging/relay/gcp/verify-public-wss.sh");
    const smoke = read("packaging/relay/gcp/public-wss-smoke.mjs");
    const bootstrap = read("packaging/relay/gcp/bootstrap.sh");

    expect(wrapper).toContain("--network bridge");
    expect(wrapper).toContain("--read-only");
    expect(wrapper).toContain("--cap-drop ALL");
    expect(wrapper).toContain("ROAMCODE_RELAY_ROOT_TOKEN_FILE=/run/secrets/relay-root-token");
    expect(wrapper).not.toContain("ROAMCODE_RELAY_ROOT_TOKEN=");
    expect(smoke).toContain("const relaySocketUrl = `wss://${relayDomain}/v1/connect`");
    expect(smoke).toContain("origin ? { origin } : {}");
    expect(smoke).toContain("device-to-host");
    expect(smoke).toContain("host-to-device");
    expect(smoke).toContain("rrt_smoke_");
    expect(smoke).toContain("let routeCreated = false");
    expect(smoke).toContain("if (routeCreated)");
    expect(smoke).toContain("total > 64 * 1024");
    expect(smoke).toContain('"DELETE", rootToken');
    expect(bootstrap).toContain("public-wss-smoke.mjs");
    expect(bootstrap).toContain("verify-public-wss.sh");
  });

  test("verifies backup integrity and boots a disposable network-isolated restore", () => {
    const backup = read("packaging/relay/gcp/backup.sh");
    const restore = read("packaging/relay/gcp/restore-check.sh");
    const verify = read("packaging/relay/gcp/verify.sh");

    expect(backup).toContain(".backup");
    expect(backup).toContain("PRAGMA integrity_check;");
    expect(backup).toContain("sha256sum");
    expect(backup).toContain('test -f "$work/accounts.db"');
    expect(backup).toContain('sync -f "$destination"');
    expect(restore).toContain("--network none");
    expect(restore).toContain("AbortSignal.timeout(5000)");
    expect(restore.match(/PRAGMA integrity_check;/g)).toHaveLength(2);
    expect(restore.match(/test -f \"\$work\/\$\{database\}\.db\"/g)).toHaveLength(2);
    expect(verify).toContain("PortBindings");
    expect(verify).toContain("RestartPolicy.Name");
    expect(verify).toContain("Config.Image");
    expect(verify).toContain("NetworkID");
    expect(verify).toContain("cloudflare-tunnel-token");
    expect(verify).toContain('previous_files" -le 3');
    expect(verify).toContain("400:10001:10001");
    expect(verify).toContain("roamcode-cloud.service");
    expect(verify).toContain("roamcode-cloud-backup.timer");
  });
});
