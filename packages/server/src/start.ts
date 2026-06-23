import { pathToFileURL } from "node:url";
import { SessionManager } from "./session-manager.js";
import { createServer } from "./transport.js";
import { loadServerConfig, assertConfigAllowsStart } from "./server-config.js";
import type { CreateServerResult } from "./transport.js";

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CreateServerResult & { url: string }> {
  const config = loadServerConfig(env);
  assertConfigAllowsStart(config); // spec §9: refuse non-loopback bind without a token

  const manager = new SessionManager(config.claude);
  const result = createServer(config, manager);
  const url = await result.app.listen({ port: config.port, host: config.bindAddress });
  return { ...result, url };
}

// Run when executed directly (node dist/start.js), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer()
    .then(({ url }) => {
      // eslint-disable-next-line no-console
      console.log(`remote-coder server listening on ${url}`);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`remote-coder server failed to start: ${(err as Error).message}`);
      process.exit(1);
    });
}
