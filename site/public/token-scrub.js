(() => {
  const accountPath = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, "") : location.pathname;
  const storageKey =
    accountPath === "/invite"
      ? "roamcode.cloud.pending-invite.v1"
      : accountPath === "/app/reset-password"
        ? "roamcode.cloud.pending-password-reset.v1"
        : undefined;
  if (!storageKey) return;
  const params = new URLSearchParams(location.search);
  if (!params.has("token")) return;
  const token = params.get("token");
  if (token) {
    try {
      sessionStorage.setItem(storageKey, token);
    } catch {
      // Leave the query intact so the account shell can retain the token in memory.
      return;
    }
  }
  params.delete("token");
  const query = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
})();
