export const SW_VERSION_PROBE = "RC_SW_VERSION_PROBE";
export const SW_VERSION_REPLY = "RC_SW_VERSION_REPLY";

type VersionReply = { type: typeof SW_VERSION_REPLY; version: string };

function isVersionReply(value: unknown): value is VersionReply {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === SW_VERSION_REPLY && typeof record.version === "string";
}

/** Installed by the page before registerSW(), allowing a new worker to tell fresh and stale clients apart. */
export function respondToServiceWorkerVersionProbe(
  event: Pick<MessageEvent, "data" | "ports">,
  buildVersion: string,
): boolean {
  if ((event.data as { type?: unknown } | null)?.type !== SW_VERSION_PROBE || !event.ports[0]) return false;
  event.ports[0].postMessage({ type: SW_VERSION_REPLY, version: buildVersion });
  return true;
}

/** Ask one open page which bundle it is running. No reply means a pre-handshake/stale client. */
export async function clientRunsBuildVersion(
  client: Pick<Client, "postMessage">,
  buildVersion: string,
  timeoutMs = 800,
  createChannel: () => MessageChannel = () => new MessageChannel(),
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const channel = createChannel();
    let settled = false;
    const finish = (matches: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(matches);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = (event) => finish(isVersionReply(event.data) && event.data.version === buildVersion);
    channel.port1.start();
    try {
      client.postMessage({ type: SW_VERSION_PROBE }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}
