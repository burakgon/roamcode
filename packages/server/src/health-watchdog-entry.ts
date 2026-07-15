import { parseHealthWatchdogEnv, runHealthWatchdog } from "./health-watchdog.js";

const config = parseHealthWatchdogEnv(process.env);
if (!config) process.exit(2);

void runHealthWatchdog(config).then(
  () => process.exit(0),
  () => process.exit(1),
);
