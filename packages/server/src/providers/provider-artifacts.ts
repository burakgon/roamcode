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
  return writeProviderArtifact(path, content, 0o600, context, ownedPaths);
}

/** Write an executable, provider-owned helper without ever making it group/world-readable. */
export function writeProviderArtifact0700(
  path: string,
  content: string,
  context: ProviderProcessContext,
  ownedPaths: string[],
): boolean {
  return writeProviderArtifact(path, content, 0o700, context, ownedPaths);
}

function writeProviderArtifact(
  path: string,
  content: string,
  mode: 0o600 | 0o700,
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
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return true;
  } catch {
    cleanupProviderArtifacts([path]);
    const index = ownedPaths.lastIndexOf(path);
    if (index >= 0) ownedPaths.splice(index, 1);
    return false;
  }
}
