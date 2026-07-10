import { join, resolve, sep } from "node:path";

/**
 * Where terminal file-exchange uploads live on disk.
 *
 * They are SERVER-OWNED scratch files (the user uploads a file so the terminal's claude can read it), so
 * they must NEVER land in the user's project tree — a stray file there dirties the git checkout and the
 * OTA updater then refuses to run (its dirty-tree guard). The original design wrote them to
 * `<session cwd>/shared_files/`, i.e. straight into whatever repo the terminal was opened in. This module
 * relocates them to the app DATA dir instead, one folder per session, with a 7-day TTL.
 */

/** Subdir (of the data dir / fsRoot fallback) that holds every terminal session's shared-files folder. */
export const TERMINAL_SHARED_DIRNAME = "terminal-shared";

/** Terminal uploads live 7 days — pruned on each upload and by a periodic sweep, so they never accumulate. */
export const TERMINAL_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the periodic prune sweep runs. */
export const TERMINAL_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** True when `path` is `root` itself or nested underneath it (same test FsService uses to confine paths). */
function isWithinRoot(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r + sep);
}

/**
 * The BASE dir that holds every terminal session's shared-files folder.
 *
 * Prefers the app DATA dir (e.g. `~/.config/roamcode/terminal-shared`) — always outside the user's
 * project tree, so uploads can never dirty a git checkout. The Files panel downloads these back through the
 * fsRoot-confined `/fs/download`, so the base MUST also sit within fsRoot; the data dir does by default
 * (`$HOME/.config/roamcode` ⊂ `$HOME`). If an operator set a NARROWER `FS_ROOT` that excludes the data
 * dir — or the data dir is unset (some test configs) — fall back to a hidden dir INSIDE fsRoot so upload +
 * download stay consistent (still outside any repo in the default `FS_ROOT=$HOME` case).
 */
export function terminalSharedBase(opts: { dataDir?: string; fsRoot: string }): string {
  const preferred = opts.dataDir ? join(opts.dataDir, TERMINAL_SHARED_DIRNAME) : undefined;
  if (preferred && isWithinRoot(preferred, opts.fsRoot)) return preferred;
  return join(opts.fsRoot, ".roamcode", TERMINAL_SHARED_DIRNAME);
}

/** The shared-files folder for ONE terminal session — a child of {@link terminalSharedBase} keyed by the
 *  session id, so different sessions never collide on a same-named upload and each ages out independently. */
export function terminalSharedDir(opts: { dataDir?: string; fsRoot: string; sessionId: string }): string {
  return join(terminalSharedBase(opts), opts.sessionId);
}
