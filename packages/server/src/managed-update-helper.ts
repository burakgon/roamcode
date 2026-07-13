#!/usr/bin/env node
import { readFileSync, unlinkSync } from "node:fs";
import { installManagedRelease, writeManagedStatus } from "./managed-runtime.js";

interface HelperConfig {
  operationId: string;
  version: string;
  installRoot: string;
  dataDir: string;
  nodePath: string;
  expectedIntegrity?: string;
  expectedIntegrities?: Record<string, string>;
  restart: boolean;
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("managed updater config path is required");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as HelperConfig;
  try {
    await installManagedRelease({
      version: config.version,
      installRoot: config.installRoot,
      dataDir: config.dataDir,
      operationId: config.operationId,
      expectedIntegrity: config.expectedIntegrity,
      expectedIntegrities: config.expectedIntegrities,
      nodePath: config.nodePath,
      restart: config.restart,
      onStatus: (status) => writeManagedStatus(config.dataDir, status),
    });
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      // best effort; config contains no secret, but should not accumulate
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `roamcode updater failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
