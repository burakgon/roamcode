import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `roamcode status` — answer "is the service installed? is the server up? which version?" at a glance,
 * without launchctl/systemctl incantations. Three steps:
 *
 *   1. `<dataDir>/service.json` (written by `roamcode install`) names the installed service, if any.
 *   2. GET /health on 127.0.0.1:<PORT> (PORT env or 4280) with a short timeout — the liveness answer.
 *   3. GET /version — OPT-IN: only when an explicit ACCESS_TOKEN is supplied in the environment.
 *      The persisted `<dataDir>/token` is deliberately NOT read here: if RoamCode is stopped and
 *      another local process owns the port, an automatic probe would hand that process the real
 *      token. Whoever explicitly exports ACCESS_TOKEN has chosen to present it; plain reachability
 *      is still an honest answer without it.
 *
 * Exit code: 0 when the server is reachable, 1 when not — so scripts can `roamcode status && …`.
 */

/** Injectable seams so status is unit-testable with no real network, filesystem, or data dir. */
export interface StatusDeps {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  /** Injectable fetch (tests fake the routes). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable file reader (throws like readFileSync when missing). Defaults to readFileSync utf8. */
  readFile?: (path: string) => string;
}

/** Probe budget per request — long enough for a healthy loopback answer, short enough to feel instant. */
const PROBE_TIMEOUT_MS = 2000;

/** The service identity persisted by `roamcode install` (see install.ts writeServiceJson). */
interface ServiceInfo {
  manager: string;
  label: string;
}

/** Parse `<dataDir>/service.json`; undefined when absent or corrupt (status must never throw on it). */
function readServiceInfo(dataDir: string, readFile: (p: string) => string): ServiceInfo | undefined {
  try {
    const parsed = JSON.parse(readFile(join(dataDir, "service.json"))) as unknown;
    if (parsed && typeof parsed === "object") {
      const { manager, label } = parsed as Record<string, unknown>;
      if (typeof manager === "string" && typeof label === "string") return { manager, label };
    }
  } catch {
    /* no service installed (or unreadable json) — both read as "not installed" */
  }
  return undefined;
}

/** PORT env when it is an integer in the server's own accepted range (1..65535), else the default
 *  4280 (PORT=0 means "pick a free port" at serve time — unknowable here, so the default is the
 *  best probe target). */
function resolvePort(env: NodeJS.ProcessEnv): number {
  const n = Number(env.PORT);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 4280;
}

/** One accurate release label from /version. Keep the v-prefixed `current` presentation, and fall back
 * to `runningVersion` only for a degraded feed response. */
function versionDetail(v: { current?: unknown; runningVersion?: unknown; runningBuild?: unknown }): string {
  const current = typeof v.current === "string" && v.current && v.current !== "—" ? v.current : "";
  if (current) return ` (${current})`;
  const version =
    typeof v.runningVersion === "string"
      ? v.runningVersion.trim()
      : typeof v.runningBuild === "string"
        ? v.runningBuild.trim()
        : "";
  if (version) return ` (v${version.replace(/^v/, "")})`;
  return "";
}

export async function runStatus(deps: StatusDeps): Promise<number> {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const fetchFn = deps.fetchFn ?? fetch;

  // (1) The installed service, if any.
  const service = readServiceInfo(deps.dataDir, readFile);
  if (service) deps.stdout(`Service: ${service.manager} · ${service.label}\n`);
  else deps.stdout("Service: none installed (run `roamcode install` to add one)\n");

  // (2) Liveness: /health is the unauthenticated probe the server keeps open for exactly this.
  const base = `http://127.0.0.1:${resolvePort(deps.env)}`;
  let reachable = false;
  try {
    const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    deps.stdout(`Server:  not reachable at ${base}\n`);
    return 1;
  }

  // (3) Best-effort build info — only with an EXPLICIT ACCESS_TOKEN (never the persisted token: see
  // the module docstring). Any failure (401, timeout) quietly degrades to plain "running" rather
  // than contradicting the /health answer we already have.
  let detail = "";
  const token = deps.env.ACCESS_TOKEN;
  if (token) {
    try {
      const res = await fetchFn(`${base}/version`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) {
        detail = versionDetail(
          (await res.json()) as { current?: unknown; runningVersion?: unknown; runningBuild?: unknown },
        );
      }
    } catch {
      /* best-effort — reachability was already established */
    }
  }
  deps.stdout(`Server:  running at ${base}${detail}\n`);
  return 0;
}
