import { useEffect, useState } from "react";
import type { ApiClient, ExtensionManifestSummary, InstalledExtension } from "../api/client";
import { Mono } from "../ui/Mono";

export function ExtensionsPanel({ api }: { api: ApiClient }) {
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [sourceDirectory, setSourceDirectory] = useState("");
  const [sourceLabel, setSourceLabel] = useState("local-ui");
  const [signature, setSignature] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [allowUnsigned, setAllowUnsigned] = useState(false);
  const [inspection, setInspection] = useState<{ manifest: ExtensionManifestSummary; integrity: string }>();
  const [approval, setApproval] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [purgeState, setPurgeState] = useState(false);

  const refresh = async () => {
    const next = await api.listExtensions();
    setExtensions(next);
  };

  useEffect(() => {
    let cancelled = false;
    if (typeof api.listExtensions !== "function") {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    void api
      .listExtensions()
      .then((next) => {
        if (!cancelled) setExtensions(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Extensions are unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const act = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await operation();
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Extension operation failed.");
    } finally {
      setBusy(undefined);
    }
  };

  const inspect = () =>
    act("inspect", async () => {
      const next = await api.inspectExtension(sourceDirectory.trim());
      setInspection(next);
      setAllowUnsigned(false);
    });

  const install = () =>
    act("install", async () => {
      if (!inspection) throw new Error("Inspect the package before installing it.");
      if ((signature.trim() && !publicKey.trim()) || (!signature.trim() && publicKey.trim())) {
        throw new Error("A signature and its public key must be supplied together.");
      }
      await api.installExtension({
        sourceDirectory: sourceDirectory.trim(),
        expectedIntegrity: inspection.integrity,
        ...(signature.trim() ? { signature: signature.trim(), publicKey: publicKey.trim() } : {}),
        ...(!signature.trim() ? { allowUnsigned } : {}),
        source: sourceLabel.trim() || "local-ui",
      });
      setInspection(undefined);
      setSourceDirectory("");
      setSignature("");
      setPublicKey("");
      setAllowUnsigned(false);
    });

  return (
    <div className="rc-extensions">
      <div className="rc-extensions__install">
        <label className="rc-settings__field">
          <span className="rc-settings__field-label">Package directory on this host</span>
          <input
            className="rc-settings__control rc-settings__control--mono"
            value={sourceDirectory}
            placeholder="/absolute/path/to/plugin"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setSourceDirectory(event.target.value);
              setInspection(undefined);
            }}
          />
        </label>
        <label className="rc-settings__field">
          <span className="rc-settings__field-label">Provenance label</span>
          <input
            className="rc-settings__control"
            value={sourceLabel}
            maxLength={500}
            onChange={(event) => setSourceLabel(event.target.value)}
          />
        </label>
        <details className="rc-extensions__signature">
          <summary>Signed package proof</summary>
          <label className="rc-settings__field">
            <span className="rc-settings__field-label">Ed25519 signature (base64)</span>
            <textarea
              className="rc-settings__control rc-extensions__textarea"
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
            />
          </label>
          <label className="rc-settings__field">
            <span className="rc-settings__field-label">Public key (PEM)</span>
            <textarea
              className="rc-settings__control rc-settings__control--mono rc-extensions__textarea"
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
            />
          </label>
        </details>
        <button
          type="button"
          className="rc-settings__secondary"
          disabled={!sourceDirectory.trim() || busy !== undefined}
          onClick={() => void inspect()}
        >
          {busy === "inspect" ? "Inspecting…" : "Inspect package"}
        </button>

        {inspection && (
          <div className="rc-extensions__proof" role="status">
            <strong>{manifestName(inspection.manifest)}</strong>
            <span>
              {inspection.manifest.kind} · {manifestVersion(inspection.manifest)}
            </span>
            <Mono muted>{inspection.integrity}</Mono>
            {manifestPermissions(inspection.manifest).length > 0 && (
              <span>Requests: {manifestPermissions(inspection.manifest).join(", ")}</span>
            )}
            {!signature.trim() && (
              <label className="rc-settings__danger-check">
                <input
                  type="checkbox"
                  checked={allowUnsigned}
                  onChange={(event) => setAllowUnsigned(event.target.checked)}
                />
                <span className="rc-settings__option-copy">
                  <strong>Install unsigned local bytes</strong>
                  <small>I reviewed this exact integrity value and accept the provenance risk.</small>
                </span>
              </label>
            )}
            <button
              type="button"
              className="rc-settings__primary"
              disabled={busy !== undefined || (!signature.trim() && !allowUnsigned)}
              onClick={() => void install()}
            >
              {busy === "install" ? "Installing…" : "Install reviewed package"}
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="rc-extensions__error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="rc-settings__hint">Loading installed extensions…</p>
      ) : extensions.length === 0 ? (
        <p className="rc-settings__hint">No extensions installed. Local-first RoamCode does not require any.</p>
      ) : (
        <div className="rc-extensions__list" aria-label="Installed extensions">
          {extensions.map((extension) => {
            const key = `${extension.kind}:${extension.id}`;
            const permissions = manifestPermissions(extension.current.manifest);
            return (
              <article className="rc-extensions__card" key={key}>
                <div className="rc-extensions__head">
                  <span>
                    <strong>{manifestName(extension.current.manifest)}</strong>
                    <small>
                      {extension.kind} · {extension.currentVersion} · {extension.enabled ? "enabled" : "disabled"}
                    </small>
                  </span>
                  <span className={`rc-extensions__trust rc-extensions__trust--${extension.current.trust}`}>
                    {extension.current.trust === "signed" ? "signature verified" : "integrity only"}
                  </span>
                </div>
                <div className="rc-extensions__meta">
                  <span>Source</span>
                  <Mono muted>{extension.current.source}</Mono>
                  <span>Integrity</span>
                  <Mono muted>{extension.current.integrity}</Mono>
                  {extension.current.signerFingerprint && (
                    <>
                      <span>Signer</span>
                      <Mono muted>{extension.current.signerFingerprint}</Mono>
                    </>
                  )}
                </div>
                {permissions.length > 0 && (
                  <p className="rc-settings__hint">Declared permissions: {permissions.join(", ")}</p>
                )}

                {approval === key ? (
                  <div className="rc-extensions__confirm" role="group" aria-label={`Approve ${extension.id}`}>
                    <p>
                      Enabling lets this package run its declared commands with:{" "}
                      {permissions.join(", ") || "no permissions"}.
                    </p>
                    <span>
                      <button
                        type="button"
                        className="rc-settings__primary"
                        disabled={busy !== undefined}
                        onClick={() =>
                          void act(`enable:${key}`, async () => {
                            await api.setExtensionEnabled(extension.kind, extension.id, true, permissions);
                            setApproval(undefined);
                          })
                        }
                      >
                        Approve and enable
                      </button>
                      <button type="button" className="rc-settings__secondary" onClick={() => setApproval(undefined)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : removing === key ? (
                  <div className="rc-extensions__confirm" role="group" aria-label={`Remove ${extension.id}`}>
                    <p>Uninstall verified package bytes? Owned state is preserved unless explicitly purged.</p>
                    <label className="rc-settings__danger-check">
                      <input
                        type="checkbox"
                        checked={purgeState}
                        onChange={(event) => setPurgeState(event.target.checked)}
                      />
                      <span>Also permanently purge plugin-owned state</span>
                    </label>
                    <span>
                      <button
                        type="button"
                        className="rc-settings__danger"
                        disabled={busy !== undefined}
                        onClick={() =>
                          void act(`remove:${key}`, async () => {
                            await api.uninstallExtension(extension.kind, extension.id, purgeState);
                            setRemoving(undefined);
                            setPurgeState(false);
                          })
                        }
                      >
                        Confirm uninstall
                      </button>
                      <button type="button" className="rc-settings__secondary" onClick={() => setRemoving(undefined)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : (
                  <div className="rc-extensions__actions">
                    {extension.enabled ? (
                      <button
                        type="button"
                        className="rc-settings__secondary"
                        disabled={busy !== undefined}
                        onClick={() =>
                          void act(`disable:${key}`, () =>
                            api.setExtensionEnabled(extension.kind, extension.id, false).then(() => undefined),
                          )
                        }
                      >
                        Disable
                      </button>
                    ) : (
                      <button type="button" className="rc-settings__secondary" onClick={() => setApproval(key)}>
                        Review and enable
                      </button>
                    )}
                    {extension.previousVersion && (
                      <button
                        type="button"
                        className="rc-settings__secondary"
                        disabled={busy !== undefined}
                        onClick={() =>
                          void act(`rollback:${key}`, () =>
                            api.rollbackExtension(extension.kind, extension.id).then(() => undefined),
                          )
                        }
                      >
                        Roll back to {extension.previousVersion}
                      </button>
                    )}
                    {!extension.enabled && (
                      <button
                        type="button"
                        className="rc-extensions__remove"
                        onClick={() => {
                          setRemoving(key);
                          setPurgeState(false);
                        }}
                      >
                        Uninstall
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <p className="rc-settings__hint rc-extensions__admin">
        Install and lifecycle changes require the host recovery credential. Provider credentials are never passed to
        extensions.
      </p>
      <style>{extensionCss}</style>
    </div>
  );
}

function manifestName(manifest: ExtensionManifestSummary): string {
  return manifest.kind === "adapter"
    ? (manifest.adapter?.displayName ?? "Adapter")
    : (manifest.displayName ?? "Plugin");
}

function manifestVersion(manifest: ExtensionManifestSummary): string {
  return manifest.kind === "adapter" ? (manifest.adapter?.version ?? "unknown") : (manifest.version ?? "unknown");
}

function manifestPermissions(manifest: ExtensionManifestSummary): string[] {
  return manifest.kind === "plugin" && Array.isArray(manifest.permissions) ? manifest.permissions : [];
}

const extensionCss = `
.rc-extensions { display: grid; gap: var(--sp-3); }
.rc-extensions__install { display: grid; gap: var(--sp-3); padding: var(--sp-3); border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); }
.rc-extensions__signature { display: grid; gap: var(--sp-2); color: var(--text-muted); font-size: var(--fs-sm); }
.rc-extensions__signature[open] { padding-bottom: var(--sp-2); }
.rc-extensions__signature summary { cursor: pointer; }
.rc-extensions__textarea { min-height: 72px; padding: var(--sp-2); resize: vertical; }
.rc-extensions__proof { display: grid; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--accent-line); border-radius: var(--radius-sm); background: var(--accent-soft); font-size: var(--fs-xs); overflow-wrap: anywhere; }
.rc-extensions__error { margin: 0; padding: var(--sp-2) var(--sp-3); color: var(--err); background: var(--err-bg); border: 1px solid var(--err-border); border-radius: var(--radius-sm); font-size: var(--fs-sm); }
.rc-extensions__list { display: grid; gap: var(--sp-3); }
.rc-extensions__card { display: grid; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); min-width: 0; }
.rc-extensions__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-2); }
.rc-extensions__head > span:first-child { display: grid; gap: 2px; min-width: 0; }
.rc-extensions__head small { color: var(--text-muted); font-size: var(--fs-xs); }
.rc-extensions__trust { flex: none; padding: 3px 7px; border: 1px solid var(--border); border-radius: var(--radius-pill); color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.rc-extensions__trust--signed { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, var(--border)); }
.rc-extensions__trust--integrity { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, var(--border)); }
.rc-extensions__meta { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 5px var(--sp-2); font-size: var(--fs-xs); }
.rc-extensions__meta > span:nth-child(odd) { color: var(--text-faint); }
.rc-extensions__meta code { overflow-wrap: anywhere; }
.rc-extensions__actions, .rc-extensions__confirm > span { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.rc-extensions__actions button, .rc-extensions__confirm button { min-height: 38px; }
.rc-extensions__confirm { display: grid; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--accent-line); border-radius: var(--radius-sm); background: var(--accent-soft); }
.rc-extensions__confirm p { margin: 0; color: var(--text); font-size: var(--fs-sm); line-height: 1.45; }
.rc-extensions__remove { min-height: 38px; padding: 0 var(--sp-3); border: 1px solid var(--err-border); border-radius: var(--radius-sm); background: transparent; color: var(--err); cursor: pointer; font: inherit; }
.rc-extensions__admin { padding-top: var(--sp-2); border-top: 1px solid var(--border); }
@media (max-width: 520px) { .rc-extensions__head { display: grid; } .rc-extensions__trust { width: max-content; } }
`;
