export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Defensive parse: the push body is attacker-influenced-ish (it comes from the push service), so a
 * malformed/empty payload must never throw inside the SW push handler — fall back to a generic shape. */
export function parsePushPayload(raw: string | undefined): PushPayload {
  const fallback: PushPayload = {
    title: "Remote Coder",
    body: "A session needs your attention",
    url: "/",
    tag: "remote-coder",
  };
  if (!raw) return fallback;
  try {
    const obj = JSON.parse(raw) as Partial<PushPayload>;
    return {
      title: typeof obj.title === "string" ? obj.title : fallback.title,
      body: typeof obj.body === "string" ? obj.body : fallback.body,
      url: typeof obj.url === "string" ? obj.url : fallback.url,
      tag: typeof obj.tag === "string" ? obj.tag : fallback.tag,
    };
  } catch {
    return fallback;
  }
}

export function notificationOptions(p: PushPayload): NotificationOptions {
  return {
    body: p.body,
    tag: p.tag,
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    data: { url: p.url },
  };
}

export function clickTargetUrl(notification: { data?: unknown }): string {
  const data = notification.data as { url?: unknown } | undefined;
  return typeof data?.url === "string" ? data.url : "/";
}
