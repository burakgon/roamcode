import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import type { ProviderProcessContext } from "./types.js";

export function cleanupProviderArtifacts(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

export function writeProviderArtifact0600(
  path: string,
  content: string,
  context: ProviderProcessContext,
  ownedPaths: string[],
): boolean {
  try {
    context.registerCleanupPaths?.([path]);
  } catch (error) {
    cleanupProviderArtifacts([path]);
    throw error;
  }
  ownedPaths.push(path);
  try {
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    cleanupProviderArtifacts([path]);
    return false;
  }
}
