import { startBlindRelay } from "./relay-start.js";

void startBlindRelay()
  .then((relay) => {
    const shutdown = () => relay.app.close().finally(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })
  .catch((error) => {
    process.stderr.write(`roamcode relay failed to start: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
