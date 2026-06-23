/** Read the `?session=<id>` deep link (set by a notification click) from a location search string. */
export function sessionIdFromLocation(search: string): string | undefined {
  const id = new URLSearchParams(search).get("session");
  return id && id.length > 0 ? id : undefined;
}
