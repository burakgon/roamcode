export interface ReplayOptions { delayMs?: number; }

export async function replayFixture(
  fixture: string,
  emit: (line: string) => void,
  opts: ReplayOptions = {},
): Promise<void> {
  const delay = opts.delayMs ?? 0;
  for (const raw of fixture.split("\n")) {
    if (!raw.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // skip non-JSON lines defensively
    }
    if (obj._dir === "out") continue; // client-sent line; the CLI did not emit it
    delete obj._dir; // fixture-only annotation, never on the wire
    emit(JSON.stringify(obj));
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}
