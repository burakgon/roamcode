import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ApiClient } from "../api/client";
import type { ClaudeAuthStatus } from "../types/server";

/**
 * Settings section to RE-AUTHENTICATE the server's Claude login from the app. When the server-side
 * subscription token expires, every turn fails with "Failed to authenticate. API Error: 401" and the only
 * fix used to be SSHing in to run `claude auth login`. This drives that flow in-app:
 *   1. "Sign in" → POST /auth/login/start returns an authorize URL.
 *   2. The user opens it in ANY browser, approves, and copies the code the callback page shows.
 *   3. Pastes the code → POST /auth/login/code finishes the exchange; the server saves fresh creds and
 *      turns work again (no restart).
 *
 * Styling is SELF-CONTAINED (inline, off the app's design tokens) so it renders identically whether it's
 * embedded in the Settings panel or surfaced standalone in the ClaudeAuthDialog — the `.rc-settings__*`
 * classes live in SettingsPanel's own <style> block and aren't present in the dialog.
 */
type Flow =
  | { step: "idle" }
  | { step: "starting" }
  | { step: "code"; loginId: string; url: string; submitting: boolean }
  | { step: "done" }
  | { step: "error"; message: string };

export function ClaudeAuthSection({ api }: { api: ApiClient }) {
  const [status, setStatus] = useState<ClaudeAuthStatus | undefined>();
  const [statusError, setStatusError] = useState(false);
  const [flow, setFlow] = useState<Flow>({ step: "idle" });
  const [code, setCode] = useState("");

  const refreshStatus = () => {
    setStatusError(false);
    void api
      .getAuthStatus()
      .then((next) => {
        setStatus(next);
        setStatusError(false);
      })
      .catch(() => setStatusError(true));
  };
  useEffect(refreshStatus, [api]);

  // The feature is off on this server (no claude bin) — render nothing rather than a dead control.
  if (status && !status.available) return null;

  const start = () => {
    setFlow({ step: "starting" });
    setCode("");
    api
      .startAuthLogin()
      .then(({ loginId, url }) => {
        let safe = Boolean(loginId) && loginId.length <= 512;
        try {
          const parsed = new URL(url);
          safe = safe && parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
        } catch {
          safe = false;
        }
        if (!safe) {
          void api.cancelAuthLogin().catch(() => {});
          setFlow({ step: "error", message: "Couldn't start Claude sign-in. Please try again." });
          return;
        }
        setFlow({ step: "code", loginId, url, submitting: false });
      })
      .catch(() => setFlow({ step: "error", message: "Couldn't start Claude sign-in. Please try again." }));
  };

  const submit = () => {
    if (flow.step !== "code" || code.trim() === "") return;
    const { loginId } = flow;
    setFlow({ ...flow, submitting: true });
    api
      .submitAuthCode(loginId, code.trim())
      .then((r) => {
        if (r.ok) {
          setFlow({ step: "done" });
          setCode("");
          refreshStatus();
        } else {
          setFlow({ step: "error", message: "Claude sign-in failed. Check the code and try again." });
        }
      })
      .catch(() => setFlow({ step: "error", message: "Claude sign-in failed. Check the code and try again." }));
  };

  const cancel = () => {
    void api.cancelAuthLogin().catch(() => {});
    setFlow({ step: "idle" });
    setCode("");
  };

  const signedIn = status?.loggedIn;
  const account = status?.email
    ? `${status.email}${status.subscriptionType ? ` · ${status.subscriptionType}` : ""}`
    : undefined;

  return (
    <div className="rc-auth" style={{ display: "grid", gap: "var(--sp-2)" }}>
      <span style={LABEL}>Claude account</span>

      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
        {statusError
          ? "Claude account status is unavailable. You can still sign in."
          : status === undefined
            ? "Checking…"
            : signedIn
              ? `Signed in${account ? ` as ${account}` : ""}.`
              : "Not signed in."}
      </div>
      {statusError && (
        <div style={{ display: "grid", gap: "var(--sp-2)" }}>
          <div role="alert" style={{ color: "var(--err)", fontSize: "var(--fs-sm)" }}>
            Claude account status is unavailable. Try again, or continue with sign-in.
          </div>
          <button type="button" style={SECONDARY_BTN} onClick={refreshStatus}>
            Retry Claude account status
          </button>
        </div>
      )}
      <p style={HINT}>
        If turns fail with “Failed to authenticate · 401”, the server&apos;s Claude login expired — sign in again here
        (no SSH needed).
      </p>

      {flow.step === "code" ? (
        <div style={{ display: "grid", gap: "var(--sp-2)" }}>
          <a href={flow.url} target="_blank" rel="noopener noreferrer" style={LINK_BTN}>
            Open the Claude sign-in page ↗
          </a>
          <p style={HINT}>Approve access in the page that opens, then paste the code it shows below.</p>
          <input
            aria-label="authorization code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste the code here"
            style={INPUT}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <button type="button" style={{ ...SECONDARY_BTN, flex: 1 }} onClick={cancel} disabled={flow.submitting}>
              Cancel
            </button>
            <button
              type="button"
              style={{ ...PRIMARY_BTN, flex: 2 }}
              onClick={submit}
              disabled={flow.submitting || code.trim() === ""}
            >
              {flow.submitting ? "Signing in…" : "Submit code"}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--sp-2)" }}>
          {flow.step === "done" && (
            <div role="status" style={{ color: "var(--ok)", fontSize: "var(--fs-sm)" }}>
              Signed in ✓
            </div>
          )}
          {flow.step === "error" && (
            <div role="alert" style={{ color: "var(--err)", fontSize: "var(--fs-sm)", overflowWrap: "anywhere" }}>
              {flow.message}
            </div>
          )}
          <button type="button" style={PRIMARY_BTN} onClick={start} disabled={flow.step === "starting"}>
            {flow.step === "starting" ? "Starting…" : signedIn ? "Re-authenticate" : "Sign in"}
          </button>
        </div>
      )}
    </div>
  );
}

const LABEL: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "var(--fs-xs)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  fontWeight: 600,
};

const HINT: CSSProperties = { margin: 0, color: "var(--text-faint)", fontSize: "var(--fs-xs)", lineHeight: 1.5 };

const INPUT: CSSProperties = {
  width: "100%",
  minHeight: "var(--tap-min)",
  padding: "0 var(--sp-3)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-sm)",
  boxSizing: "border-box",
};

const BTN_BASE: CSSProperties = {
  minHeight: "var(--tap-min)",
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  font: "inherit",
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const PRIMARY_BTN: CSSProperties = {
  ...BTN_BASE,
  background: "var(--accent-grad)",
  color: "var(--on-accent)",
  border: "1px solid transparent",
};

const SECONDARY_BTN: CSSProperties = {
  ...BTN_BASE,
  fontWeight: 500,
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border)",
};

const LINK_BTN: CSSProperties = { ...SECONDARY_BTN, textDecoration: "none" };
