import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";

export interface ServerRuntimeConfig {
  /** TCP port to listen on. Default 4280. */
  port: number;
  /** Address to bind. Default "127.0.0.1" (loopback). */
  bindAddress: string;
  /** Mandatory access token. Optional only for loopback binds (spec §9). */
  accessToken?: string;
  /** Root directory the file picker / fs-service is confined to. Default $HOME or cwd. */
  fsRoot: string;
  /** Max bytes accepted for an upload. Default 25 MiB. */
  maxUploadBytes: number;
  /**
   * Trust X-Forwarded-* (passed to Fastify as `trustProxy`). Default false.
   * Set true when running behind a reverse proxy (Caddy/Cloudflare) so `request.ip` is the
   * real client IP — otherwise the per-client auth lockout collapses to the proxy's single IP.
   */
  trustProxy?: boolean;
  /** The claude-spawn config (claudeBin + default model/effort). */
  claude: ServerConfig;
}

export function loadServerConfig(env: NodeJS.ProcessEnv): ServerRuntimeConfig {
  const port = env.PORT ? Number.parseInt(env.PORT, 10) : 4280;
  const maxUploadBytes = env.MAX_UPLOAD_BYTES
    ? Number.parseInt(env.MAX_UPLOAD_BYTES, 10)
    : 26214400;
  const cfg: ServerRuntimeConfig = {
    port,
    bindAddress: env.BIND_ADDRESS ?? "127.0.0.1",
    fsRoot: env.FS_ROOT ?? env.HOME ?? process.cwd(),
    maxUploadBytes,
    claude: loadConfig(env),
  };
  if (env.ACCESS_TOKEN) cfg.accessToken = env.ACCESS_TOKEN;
  if (env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true") cfg.trustProxy = true;
  return cfg;
}

export function isLoopbackAddress(address: string): boolean {
  if (address === "::1" || address === "localhost") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(address);
}

/** Spec §9: refuse to serve a non-loopback bind without a token. */
export function assertConfigAllowsStart(cfg: ServerRuntimeConfig): void {
  if (!isLoopbackAddress(cfg.bindAddress) && !cfg.accessToken) {
    throw new Error(
      `refusing to start: bind address ${cfg.bindAddress} is not loopback and no ACCESS_TOKEN is set (set ACCESS_TOKEN or bind to 127.0.0.1)`,
    );
  }
}
