import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ApiClient } from "../api/client";
import type { CodexAuthStatus, CodexLoginStart, CodexLoginStatus } from "../providers/types";

type Flow =
  | { step: "idle" }
  | { step: "starting" }
  | { step: "device"; loginId: string; userCode: string; verificationUrl: string; expiresAt: number }
  | { step: "error"; message: string };

const POLL_MS = 1_500;
const MAX_LOGIN_FUTURE_MS = 15 * 60_000;

function validLogin(login: CodexLoginStart): boolean {
  if (!login.loginId || login.loginId.length > 256 || !login.userCode || login.userCode.length > 256) return false;
  if (
    !Number.isFinite(login.expiresAt) ||
    login.expiresAt <= Date.now() ||
    login.expiresAt > Date.now() + MAX_LOGIN_FUTURE_MS
  )
    return false;
  try {
    const url = new URL(login.verificationUrl);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function accountSummary(status: CodexAuthStatus | undefined, statusError: boolean): string {
  if (statusError) return "Codex account status is unavailable. You can still sign in.";
  if (!status) return "Checking…";
  if (!status.available) return "Codex is not available on this server.";
  if (!status.authenticated) return "Not signed in.";
  const method = status.authMethod === "apiKey" ? "API key" : status.authMethod === "chatgpt" ? "ChatGPT" : undefined;
  return `Signed in${method ? ` with ${method}` : ""}${status.plan ? ` · ${status.plan}` : ""}.`;
}

export function CodexAuthSection({ api }: { api: ApiClient }) {
  const [status, setStatus] = useState<CodexAuthStatus>();
  const [statusError, setStatusError] = useState(false);
  const [flow, setFlow] = useState<Flow>({ step: "idle" });
  const [copyFeedback, setCopyFeedback] = useState<string>();
  const generation = useRef(0);
  const activeLogin = useRef<string | undefined>(undefined);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function clearTimers() {
    clearTimeout(pollTimer.current);
    clearTimeout(expiryTimer.current);
    pollTimer.current = undefined;
    expiryTimer.current = undefined;
  }

  function cancelLogin(loginId: string) {
    void api.cancelProviderLogin("codex", loginId).catch(() => {});
  }

  function abandonActive() {
    clearTimers();
    const loginId = activeLogin.current;
    activeLogin.current = undefined;
    if (loginId) cancelLogin(loginId);
  }

  useEffect(() => {
    let alive = true;
    const expectedGeneration = generation.current;
    void api
      .getProviderAuthStatus("codex")
      .then((next) => {
        if (alive && generation.current === expectedGeneration) {
          setStatus(next);
          setStatusError(false);
        }
      })
      .catch(() => {
        if (alive && generation.current === expectedGeneration) setStatusError(true);
      });
    return () => {
      alive = false;
      generation.current += 1;
      abandonActive();
    };
    // The client object identifies the server connection. A replacement starts a fresh status check.
  }, [api]);

  function expire(expectedGeneration: number, loginId: string) {
    if (generation.current !== expectedGeneration || activeLogin.current !== loginId) return;
    activeLogin.current = undefined;
    clearTimers();
    cancelLogin(loginId);
    setFlow({ step: "error", message: "The Codex sign-in code expired. Start again to get a new code." });
  }

  function refreshAccount(expectedGeneration: number) {
    void api
      .getProviderAuthStatus("codex")
      .then((next) => {
        if (generation.current !== expectedGeneration) return;
        setStatus(next);
        setStatusError(false);
      })
      .catch(() => {
        if (generation.current === expectedGeneration) setStatusError(true);
      });
  }

  function finishLogin(
    expectedGeneration: number,
    loginId: string,
    status: Exclude<CodexLoginStatus["status"], "pending">,
  ) {
    if (generation.current !== expectedGeneration || activeLogin.current !== loginId) return;
    activeLogin.current = undefined;
    clearTimers();
    if (status === "completed") {
      setFlow({ step: "idle" });
      refreshAccount(expectedGeneration);
    } else if (status === "failed") {
      setFlow({ step: "error", message: "Codex sign-in failed. Start again to retry." });
    } else if (status === "canceled") {
      setFlow({ step: "error", message: "Codex sign-in was canceled. Start again to retry." });
    } else if (status === "expired") {
      setFlow({ step: "error", message: "The Codex sign-in code expired. Start again to get a new code." });
    } else {
      setFlow({ step: "error", message: "This Codex sign-in is no longer available. Start again to retry." });
    }
  }

  function schedulePoll(expectedGeneration: number, loginId: string, expiresAt: number) {
    pollTimer.current = setTimeout(() => {
      if (generation.current !== expectedGeneration || activeLogin.current !== loginId) return;
      if (Date.now() >= expiresAt) {
        expire(expectedGeneration, loginId);
        return;
      }
      void api
        .getProviderLoginStatus("codex", loginId)
        .then((next) => {
          if (generation.current !== expectedGeneration || activeLogin.current !== loginId) return;
          if (next.status === "pending") schedulePoll(expectedGeneration, loginId, expiresAt);
          else finishLogin(expectedGeneration, loginId, next.status);
        })
        .catch(() => {
          if (generation.current === expectedGeneration && activeLogin.current === loginId) {
            schedulePoll(expectedGeneration, loginId, expiresAt);
          }
        });
    }, POLL_MS);
  }

  async function start() {
    generation.current += 1;
    abandonActive();
    const expectedGeneration = generation.current;
    setCopyFeedback(undefined);
    setFlow({ step: "starting" });
    try {
      const login = await api.startProviderLogin("codex");
      if (generation.current !== expectedGeneration) {
        if (login.loginId) cancelLogin(login.loginId);
        return;
      }
      if (!validLogin(login)) {
        if (login.loginId) cancelLogin(login.loginId);
        setFlow({ step: "error", message: "Could not start Codex sign-in. Please try again." });
        return;
      }
      activeLogin.current = login.loginId;
      setFlow({ step: "device", ...login });
      expiryTimer.current = setTimeout(
        () => expire(expectedGeneration, login.loginId),
        Math.max(0, login.expiresAt - Date.now()),
      );
      schedulePoll(expectedGeneration, login.loginId, login.expiresAt);
    } catch {
      if (generation.current === expectedGeneration) {
        setFlow({ step: "error", message: "Could not start Codex sign-in. Please try again." });
      }
    }
  }

  function cancel() {
    generation.current += 1;
    abandonActive();
    setCopyFeedback(undefined);
    setFlow({ step: "idle" });
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopyFeedback("Copied device code.");
    } catch {
      setCopyFeedback("Could not copy the device code.");
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>{accountSummary(status, statusError)}</div>
      {statusError && flow.step !== "device" && (
        <button
          type="button"
          style={SECONDARY_BTN}
          onClick={() => {
            setStatusError(false);
            refreshAccount(generation.current);
          }}
        >
          Retry Codex account status
        </button>
      )}

      {flow.step === "device" ? (
        <div style={{ display: "grid", gap: "var(--sp-2)" }}>
          <p style={HINT}>Open the verification page, then enter this one-time device code.</p>
          <strong style={CODE}>{flow.userCode}</strong>
          <button type="button" style={SECONDARY_BTN} onClick={() => void copyCode(flow.userCode)}>
            Copy device code
          </button>
          {copyFeedback && (
            <span role="status" style={HINT}>
              {copyFeedback}
            </span>
          )}
          <a href={flow.verificationUrl} target="_blank" rel="noopener noreferrer" style={LINK_BTN}>
            Open Codex verification ↗
          </a>
          <button type="button" style={SECONDARY_BTN} onClick={cancel}>
            Cancel Codex sign-in
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--sp-2)" }}>
          {flow.step === "error" && (
            <div role="alert" style={{ color: "var(--err)", fontSize: "var(--fs-sm)" }}>
              {flow.message}
            </div>
          )}
          <button
            type="button"
            style={PRIMARY_BTN}
            onClick={() => void start()}
            disabled={flow.step === "starting" || status?.available === false}
          >
            {flow.step === "starting"
              ? "Starting…"
              : status?.authenticated
                ? "Re-authenticate Codex"
                : "Sign in to Codex"}
          </button>
        </div>
      )}
    </div>
  );
}

const HINT: CSSProperties = { margin: 0, color: "var(--text-faint)", fontSize: "var(--fs-xs)", lineHeight: 1.5 };
const CODE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-lg)",
  letterSpacing: "0.08em",
  overflowWrap: "anywhere",
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
