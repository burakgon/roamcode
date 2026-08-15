import { useCallback, useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { TROUBLESHOOTING_URL } from "../config";
import type { ApiClient } from "../api/client";
import type { DiagnosticsInfo } from "../types/server";
import { providerDisplayName } from "../session/provider-display";

/**
 * The Node's own health, in the app.
 *
 * The server has always produced this report at `GET /diag`, and the troubleshooting guide tells people to
 * `curl` it — but nothing in the product ever showed it. The consequence that matters: a Node whose native
 * SQLite module failed to load runs on a NON-DURABLE in-memory store, so every restart silently drops the
 * session index, and the only way to find out was a command line. Now the app says so.
 */
export function NodeDiagnostics({ api }: { api: ApiClient }) {
  const [diag, setDiag] = useState<DiagnosticsInfo>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(() => {
    let alive = true;
    setState("loading");
    void api
      .getDiagnostics()
      .then((next) => {
        if (!alive) return;
        setDiag(next);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => load(), [load]);

  if (state === "loading") return <p className="rc-settings__hint">Checking this Node…</p>;
  if (state === "error") {
    return (
      <p className="rc-diag__row" role="alert">
        <span className="rc-settings__hint">Couldn&apos;t read this Node&apos;s health report.</span>
        <button type="button" className="rc-diag__retry" onClick={load}>
          Retry
        </button>
      </p>
    );
  }

  const storeMode = diag?.storeMode;
  const providers = Object.entries(diag?.providers ?? {});
  return (
    <div className="rc-diag">
      {/* The one finding worth interrupting for: nothing this Node records survives a restart. */}
      {storeMode === "memory-fallback" && (
        <div className="rc-diag__alarm" role="alert">
          <span aria-hidden="true" className="rc-diag__alarm-icon">
            <Icon name="alert" size={16} />
          </span>
          <span>
            <strong>Sessions are not being saved.</strong> This Node fell back to an in-memory store because its native
            SQLite module didn&apos;t load, so the session list is lost on every restart — including an update. Running
            terminals are unaffected until then.{" "}
            <a href={TROUBLESHOOTING_URL} target="_blank" rel="noreferrer" className="rc-diag__link">
              How to fix it
            </a>
          </span>
        </div>
      )}

      <dl className="rc-diag__facts">
        <dt>Session storage</dt>
        <dd>
          {storeMode === "sqlite" ? "Durable (SQLite)" : storeMode === "memory-fallback" ? "In memory only" : "—"}
        </dd>

        {providers.map(([id, capability]) => (
          <div key={id} className="rc-diag__pair">
            <dt>{providerDisplayName(id)}</dt>
            <dd>
              {!capability.terminalAvailable
                ? "Not installed on this Node"
                : capability.metadataAvailable
                  ? `Ready${capability.version ? ` · ${capability.version}` : ""}`
                  : "Runs, but account and usage details are unavailable"}
            </dd>
          </div>
        ))}

        <dt>Running version</dt>
        <dd>
          {diag?.current && diag.current !== "—" ? diag.current : (diag?.runningVersion ?? "—")}
          {diag?.installDrift ? " · restart pending" : ""}
        </dd>

        <dt>Node.js</dt>
        <dd>{diag?.node ?? "—"}</dd>
      </dl>

      <p className="rc-settings__hint">
        <a href={TROUBLESHOOTING_URL} target="_blank" rel="noreferrer" className="rc-diag__link">
          Troubleshooting guide
        </a>
      </p>
    </div>
  );
}

export const nodeDiagnosticsCss = `
.rc-diag { display: grid; gap: var(--sp-3); }
.rc-diag__row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin: 0; }
.rc-diag__retry {
  min-height: var(--control-h); padding: 0 var(--sp-3);
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text); font-size: var(--fs-xs); cursor: pointer;
}
.rc-diag__retry:hover { background: var(--surface-3); }
.rc-diag__alarm {
  display: flex; gap: var(--sp-2); align-items: flex-start;
  padding: var(--sp-3); border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border: 1px solid var(--warn);
  color: var(--text); font-size: var(--fs-sm); line-height: 1.5;
}
.rc-diag__alarm-icon { flex: none; color: var(--warn); display: inline-flex; margin-top: 2px; }
.rc-diag__facts { display: grid; gap: 2px; margin: 0; font-size: var(--fs-sm); }
.rc-diag__facts dt { color: var(--text-faint); font-size: var(--fs-xs); }
.rc-diag__facts dd { margin: 0 0 var(--sp-2); color: var(--text); }
.rc-diag__pair { display: contents; }
.rc-diag__link { color: var(--text-muted); text-decoration: underline; }
.rc-diag__link:hover { color: var(--text); }
`;
