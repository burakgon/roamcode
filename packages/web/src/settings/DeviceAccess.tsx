import { Fragment, useCallback, useEffect, useState } from "react";
import { ApiError, claimPairing, type ApiClient } from "../api/client";
import { defaultDeviceName } from "../auth/device-name";
import type { DeviceInfo, DeviceListResponse, PairingStartResponse } from "../types/server";
import { Icon } from "../ui/Icon";
import { InlineConfirm } from "../ui/InlineConfirm";

interface PairingView extends PairingStartResponse {
  url: string;
  svgUrl?: string;
  knownDeviceIds: string[];
}

interface RelayPairingView {
  url: string;
  expiresAt: number;
  svgUrl?: string;
  knownDeviceIds: string[];
}

type DeviceConfirmation = { kind: "revoke" | "unpair"; device: DeviceInfo } | { kind: "reset" };

export interface DeviceAccessProps {
  api: ApiClient;
  onTokenChanged?: (token: string) => void;
  onUnpaired?: () => void;
}

function pairingUrl(secret: string): string {
  const url = new URL("/", window.location.origin);
  url.hash = new URLSearchParams({ pair: secret }).toString();
  return url.toString();
}

function lastSeenLabel(device: DeviceInfo, now: number): string {
  const seconds = Math.max(0, Math.floor((now - device.lastSeenAt) / 1000));
  if (seconds < 60) return "active now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function DeviceAccess({ api, onTokenChanged, onUnpaired }: DeviceAccessProps) {
  const [inventory, setInventory] = useState<DeviceListResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState<PairingView>();
  const [relayPairing, setRelayPairing] = useState<RelayPairingView>();
  const [pairingBusy, setPairingBusy] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState<string>();
  const [confirmation, setConfirmation] = useState<DeviceConfirmation>();
  const [renameId, setRenameId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [pairedNotice, setPairedNotice] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const next = await api.listDevices();
      setInventory(next);
      setError(undefined);
    } catch {
      setError("Couldn't load paired devices.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pairing && !relayPairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const inventoryTimer = window.setInterval(() => void refresh(), 2500);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(inventoryTimer);
    };
  }, [pairing, refresh, relayPairing]);

  useEffect(() => {
    const activePairing = pairing ?? relayPairing;
    if (!activePairing || !inventory) return;
    const enrolled = inventory.devices.find((device) => !activePairing.knownDeviceIds.includes(device.id));
    if (!enrolled) return;
    setPairing(undefined);
    setRelayPairing(undefined);
    setPairedNotice(`${enrolled.name} paired successfully.`);
  }, [inventory, pairing, relayPairing]);

  async function startPairing() {
    setPairingBusy(true);
    setCopied(false);
    setPairedNotice(undefined);
    setError(undefined);
    setRelayPairing(undefined);
    try {
      const started = await api.startPairing();
      const url = pairingUrl(started.secret);
      // QR encoding is used only on demand; keep it out of the PWA's critical startup bundle.
      const { default: QRCode } = await import("qrcode");
      const svg = await QRCode.toString(url, {
        type: "svg",
        margin: 1,
        width: 224,
        color: { dark: "#171719", light: "#ffffff" },
      });
      setPairing({
        ...started,
        url,
        knownDeviceIds: inventory?.devices.map((device) => device.id) ?? [],
        svgUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      });
      setNow(Date.now());
    } catch {
      setError("Couldn't create a pairing link. Try again.");
    } finally {
      setPairingBusy(false);
    }
  }

  async function startRelayPairing() {
    setPairingBusy(true);
    setCopied(false);
    setPairedNotice(undefined);
    setError(undefined);
    setPairing(undefined);
    try {
      const started = await api.startRelayPairing();
      const { default: QRCode } = await import("qrcode");
      const svg = await QRCode.toString(started.url, {
        type: "svg",
        margin: 1,
        width: 224,
        color: { dark: "#171719", light: "#ffffff" },
      });
      setRelayPairing({
        url: started.url,
        expiresAt: started.pairing.expiresAt,
        knownDeviceIds: inventory?.devices.map((device) => device.id) ?? [],
        svgUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      });
      setNow(Date.now());
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 409
          ? "Remote pairing is not configured on this host yet."
          : "Couldn't create a remote pairing link. Try again.",
      );
    } finally {
      setPairingBusy(false);
    }
  }

  async function upgradeCurrentBrowser() {
    setUpgradeBusy(true);
    setError(undefined);
    try {
      const started = await api.startPairing();
      const enrollment = await claimPairing(started.secret, defaultDeviceName());
      onTokenChanged?.(enrollment.token);
      setPairedNotice("This browser now has its own revocable key.");
    } catch {
      setError("Couldn't upgrade this browser's access key. Try again.");
    } finally {
      setUpgradeBusy(false);
    }
  }

  async function revoke(device: DeviceInfo) {
    setDeviceBusy(device.id);
    setError(undefined);
    try {
      await api.revokeDevice(device.id);
      setConfirmation(undefined);
      await refresh();
    } catch {
      setError(`Couldn't revoke ${device.name}.`);
    } finally {
      setDeviceBusy(undefined);
    }
  }

  async function unpair(device: DeviceInfo) {
    setDeviceBusy(device.id);
    setError(undefined);
    try {
      await api.revokeDevice(device.id);
      setConfirmation(undefined);
      onUnpaired?.();
    } catch {
      setError("Couldn't unpair this device.");
    } finally {
      setDeviceBusy(undefined);
    }
  }

  async function rename(device: DeviceInfo) {
    const name = renameDraft.trim();
    if (!name || name === device.name) {
      setRenameId(undefined);
      return;
    }
    try {
      await api.renameDevice(device.id, name);
      setRenameId(undefined);
      await refresh();
    } catch {
      setError(`Couldn't rename ${device.name}.`);
    }
  }

  async function resetAllAccess() {
    setResetBusy(true);
    setError(undefined);
    try {
      const reset = await api.resetAccess();
      onTokenChanged?.(reset.token);
      setInventory({ devices: [] });
      setConfirmation(undefined);
      setPairedNotice(`Access reset. ${reset.revokedDevices} device${reset.revokedDevices === 1 ? "" : "s"} revoked.`);
    } catch {
      setError("Couldn't reset access. Use the host recovery key or the offline CLI recovery flow.");
    } finally {
      setResetBusy(false);
    }
  }

  const secondsLeft = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;
  const pairingExpired = Boolean(pairing && secondsLeft === 0);
  const relaySecondsLeft = relayPairing ? Math.max(0, Math.ceil((relayPairing.expiresAt - now) / 1000)) : 0;
  const relayPairingExpired = Boolean(relayPairing && relaySecondsLeft === 0);

  return (
    <div className="rc-devices">
      {!loading && inventory && inventory.currentDeviceId === undefined && (
        <div className="rc-devices__legacy" role="status">
          <Icon name="alert" size={15} />
          <span>
            This browser uses the legacy shared host key. New pairings get their own key and can be revoked
            independently.
          </span>
          {onTokenChanged && (
            <button type="button" disabled={upgradeBusy} onClick={() => void upgradeCurrentBrowser()}>
              {upgradeBusy ? "Upgrading…" : "Make revocable"}
            </button>
          )}
        </div>
      )}

      {pairedNotice && (
        <div className="rc-devices__success" role="status">
          <Icon name="check" size={15} /> {pairedNotice}
        </div>
      )}

      {loading ? (
        <p className="rc-devices__muted">Loading paired devices…</p>
      ) : inventory && inventory.devices.length > 0 ? (
        <div className="rc-devices__list" aria-label="Paired devices">
          {inventory.devices.map((device) => {
            const current = device.id === inventory.currentDeviceId;
            const confirming =
              confirmation?.kind !== "reset" && confirmation?.device.id === device.id ? confirmation : undefined;
            return (
              <Fragment key={device.id}>
                <div className="rc-devices__row">
                  <span className="rc-devices__glyph" aria-hidden="true">
                    <Icon name="terminal" size={16} />
                  </span>
                  <span className="rc-devices__copy">
                    {renameId === device.id ? (
                      <form
                        className="rc-devices__rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void rename(device);
                        }}
                      >
                        <input
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          aria-label={`Rename ${device.name}`}
                          maxLength={80}
                          autoFocus
                        />
                        <button type="submit" aria-label={`Save ${device.name}`}>
                          <Icon name="check" size={13} />
                        </button>
                        <button type="button" aria-label="Cancel rename" onClick={() => setRenameId(undefined)}>
                          <Icon name="x" size={13} />
                        </button>
                      </form>
                    ) : (
                      <strong>
                        {device.name} {current && <span className="rc-devices__current">this device</span>}
                      </strong>
                    )}
                    <small>Paired · {lastSeenLabel(device, now)}</small>
                  </span>
                  {renameId !== device.id && (
                    <span className="rc-devices__actions">
                      <button
                        type="button"
                        onClick={() => {
                          setRenameId(device.id);
                          setRenameDraft(device.name);
                        }}
                      >
                        Rename
                      </button>
                      {current ? (
                        <button
                          type="button"
                          className="rc-devices__revoke"
                          aria-expanded={confirming?.kind === "unpair"}
                          onClick={() => setConfirmation({ kind: "unpair", device })}
                        >
                          Unpair
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rc-devices__revoke"
                          aria-expanded={confirming?.kind === "revoke"}
                          onClick={() => setConfirmation({ kind: "revoke", device })}
                        >
                          Revoke
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {confirming && (
                  <InlineConfirm
                    className="rc-devices__confirm"
                    message={
                      confirming.kind === "unpair"
                        ? `Unpair ${device.name}? This browser will return to the sign-in screen immediately.`
                        : `Revoke ${device.name}? It will lose terminal and notification access immediately.`
                    }
                    confirmLabel={confirming.kind === "unpair" ? `Unpair ${device.name}` : `Revoke ${device.name}`}
                    busy={deviceBusy === device.id}
                    onCancel={() => setConfirmation(undefined)}
                    onConfirm={() => void (confirming.kind === "unpair" ? unpair(device) : revoke(device))}
                  />
                )}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <p className="rc-devices__muted">No revocable device keys yet.</p>
      )}

      {relayPairing && (
        <div className="rc-devices__pair rc-devices__pair--remote" role="region" aria-label="Pair for remote access">
          {relayPairing.svgUrl && !relayPairingExpired && (
            <img
              src={relayPairing.svgUrl}
              alt="QR code for encrypted remote RoamCode access"
              width={224}
              height={224}
            />
          )}
          <strong>{relayPairingExpired ? "Remote pairing link expired" : "Scan from any network"}</strong>
          <span>
            {relayPairingExpired
              ? "Create a fresh link to continue."
              : `One use · expires in ${Math.floor(relaySecondsLeft / 60)}:${String(relaySecondsLeft % 60).padStart(2, "0")}`}
          </span>
          {!relayPairingExpired && (
            <div className="rc-devices__grant">
              <strong>End-to-end encrypted</strong>
              <span>Terminal · API · files · notifications from outside your network</span>
              <small>
                The relay routes encrypted bytes and cannot read prompts, code, terminal output, or credentials.
              </small>
            </div>
          )}
          {!relayPairingExpired && <code>{relayPairing.url}</code>}
          <div className="rc-devices__pair-actions">
            {relayPairingExpired ? (
              <button type="button" className="rc-devices__primary" onClick={() => void startRelayPairing()}>
                New remote link
              </button>
            ) : (
              <button
                type="button"
                className="rc-devices__primary"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(relayPairing.url)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            )}
            <button type="button" className="rc-devices__secondary" onClick={() => setRelayPairing(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!pairing && !relayPairing && (
        <div className="rc-devices__remote">
          <span className="rc-devices__glyph" aria-hidden="true">
            <Icon name="lock" size={16} />
          </span>
          <span>
            <strong>Remote access</strong>
            <small>Pair through an end-to-end encrypted relay; no inbound port or public host URL required.</small>
          </span>
          <button
            type="button"
            className="rc-devices__primary"
            disabled={pairingBusy}
            onClick={() => void startRelayPairing()}
          >
            {pairingBusy ? "Creating…" : "Pair remotely"}
          </button>
        </div>
      )}

      {pairing ? (
        <div className="rc-devices__pair" role="region" aria-label="Pair another device">
          {pairing.svgUrl && !pairingExpired && (
            <img src={pairing.svgUrl} alt="QR code for pairing another RoamCode device" width={224} height={224} />
          )}
          <strong>{pairingExpired ? "Pairing link expired" : "Scan with the new device"}</strong>
          <span>
            {pairingExpired
              ? "Create a fresh link to continue."
              : `One use · expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
          </span>
          {!pairingExpired && (
            <div className="rc-devices__grant">
              <strong>Access granted</strong>
              <span>Direct host · API · terminal · files · notifications</span>
              <small>Never grants provider credentials, source ownership, or cloud-account access.</small>
            </div>
          )}
          {!pairingExpired && <code>{pairing.url}</code>}
          <div className="rc-devices__pair-actions">
            {pairingExpired ? (
              <button type="button" className="rc-devices__primary" onClick={() => void startPairing()}>
                New pairing link
              </button>
            ) : (
              <button
                type="button"
                className="rc-devices__primary"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(pairing.url)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            )}
            <button type="button" className="rc-devices__secondary" onClick={() => setPairing(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      ) : !relayPairing ? (
        <button
          type="button"
          className="rc-devices__primary"
          disabled={pairingBusy}
          onClick={() => void startPairing()}
        >
          <Icon name="plus" size={15} />
          {pairingBusy ? "Creating…" : "Pair another device"}
        </button>
      ) : null}

      {!loading && inventory?.currentDeviceId === undefined && onTokenChanged && (
        <div className="rc-devices__reset">
          <span>
            <strong>Recovery reset</strong>
            <small>Replace the host key and revoke every paired device. Running agent sessions keep running.</small>
          </span>
          <button
            type="button"
            disabled={resetBusy}
            aria-expanded={confirmation?.kind === "reset"}
            onClick={() => setConfirmation({ kind: "reset" })}
          >
            {resetBusy ? "Resetting…" : "Reset all access"}
          </button>
        </div>
      )}

      {confirmation?.kind === "reset" && (
        <InlineConfirm
          message="This revokes every paired device and replaces the host recovery key. Running agent sessions keep running."
          confirmLabel="Reset access now"
          requireText="RESET"
          busy={resetBusy}
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => void resetAllAccess()}
        />
      )}

      {error && (
        <p className="rc-devices__error" role="alert">
          {error}
        </p>
      )}
      <style>{deviceCss}</style>
    </div>
  );
}

const deviceCss = `
.rc-devices { display: grid; gap: var(--sp-3); }
.rc-devices__muted, .rc-devices__error { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
.rc-devices__error { color: var(--err); }
.rc-devices__success { display: flex; align-items: center; gap: var(--sp-2); color: var(--text); font-size: var(--fs-xs); }
.rc-devices__remote { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-1); }
.rc-devices__remote > span:not(.rc-devices__glyph) { display: grid; gap: 2px; min-width: 0; }
.rc-devices__remote small { color: var(--text-muted); line-height: 1.45; }
.rc-devices__pair--remote { border-color: color-mix(in srgb, var(--accent) 34%, var(--border)); }
@media (max-width: 560px) { .rc-devices__remote { grid-template-columns: auto minmax(0, 1fr); } .rc-devices__remote .rc-devices__primary { grid-column: 1 / -1; width: 100%; } }
.rc-devices__success > :first-child { color: var(--coral); }
.rc-devices__legacy {
  display: flex; gap: var(--sp-2); align-items: flex-start;
  padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text-muted); background: var(--surface-2); font-size: var(--fs-xs); line-height: 1.45;
}
.rc-devices__legacy > :first-child { color: var(--warn); flex: none; margin-top: 1px; }
.rc-devices__legacy button { flex: none; align-self: center; min-height: 34px; padding: 0 var(--sp-2); border: 1px solid var(--accent-line); border-radius: var(--radius-sm); background: transparent; color: var(--coral); cursor: pointer; font-size: var(--fs-xs); }
.rc-devices__legacy button:disabled { opacity: .55; cursor: default; }
.rc-devices__list { display: grid; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.rc-devices__row { display: flex; align-items: center; gap: var(--sp-3); min-height: 58px; padding: var(--sp-2) var(--sp-3); }
.rc-devices__row + .rc-devices__row, .rc-devices__confirm + .rc-devices__row { border-top: 1px solid var(--border); }
.rc-devices__confirm { border-width: 1px 0 0; border-radius: 0; }
.rc-devices__glyph { width: 32px; height: 32px; display: grid; place-items: center; flex: none; border-radius: var(--radius-sm); background: var(--tile-bg); color: var(--text-muted); }
.rc-devices__copy { min-width: 0; flex: 1; display: grid; gap: 2px; }
.rc-devices__copy strong { font-size: var(--fs-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-devices__copy small { color: var(--text-muted); font-size: var(--fs-xs); }
.rc-devices__current { margin-left: var(--sp-1); color: var(--coral); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.rc-devices__actions { display: flex; gap: 5px; }
.rc-devices__actions > button, .rc-devices__revoke { min-height: 34px; padding: 0 var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer; font-size: 10px; }
.rc-devices__revoke:hover { color: var(--err); border-color: var(--err-border); }
.rc-devices__rename { display: flex; gap: 4px; min-width: 0; }
.rc-devices__rename input { min-width: 0; flex: 1; min-height: 32px; padding: 0 7px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); color: var(--text); font: 500 11px/1 var(--font-mono); }
.rc-devices__rename button { width: 32px; min-height: 32px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }
.rc-devices__primary, .rc-devices__secondary { min-height: var(--tap-min); border-radius: var(--radius-sm); font: inherit; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2); }
.rc-devices__primary { border: none; padding: 0 var(--sp-3); color: var(--on-accent); background: var(--accent-grad); font-weight: 600; }
.rc-devices__primary:disabled { opacity: .55; cursor: default; }
.rc-devices__secondary { border: 1px solid var(--border); padding: 0 var(--sp-3); color: var(--text-muted); background: transparent; }
.rc-devices__pair { display: grid; justify-items: center; gap: var(--sp-2); padding: var(--sp-4); border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--surface-2); text-align: center; }
.rc-devices__pair img { width: min(224px, 100%); height: auto; border-radius: var(--radius-sm); background: #fff; }
.rc-devices__pair > span { color: var(--text-muted); font-size: var(--fs-xs); }
.rc-devices__grant { width: 100%; display: grid; gap: 3px; padding: 9px; border: 1px solid var(--border); border-radius: 8px; text-align: left; background: var(--bg); }
.rc-devices__grant strong { color: var(--text); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
.rc-devices__grant span, .rc-devices__grant small { color: var(--text-muted); font-size: 10px; line-height: 1.4; }
.rc-devices__grant small { color: var(--text-faint); }
.rc-devices__pair code { width: 100%; padding: var(--sp-2); overflow-wrap: anywhere; color: var(--text-muted); background: var(--bg); border-radius: var(--radius-sm); font-size: 10px; user-select: all; }
.rc-devices__pair-actions { width: 100%; display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); margin-top: var(--sp-1); }
.rc-devices__reset { display: flex; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--err-border); border-radius: var(--radius-sm); background: var(--err-soft); }
.rc-devices__reset > span { min-width: 0; display: grid; gap: 2px; }
.rc-devices__reset strong { color: var(--text); font-size: var(--fs-xs); }
.rc-devices__reset small { color: var(--text-muted); font-size: 10px; line-height: 1.4; }
.rc-devices__reset button { flex: none; min-height: 36px; padding: 0 9px; border: 1px solid var(--err-border); border-radius: 8px; background: transparent; color: var(--err); cursor: pointer; font-size: 10px; }
@media (max-width: 560px) {
  .rc-devices__legacy button,.rc-devices__actions>button,.rc-devices__rename input,.rc-devices__rename button,.rc-devices__reset button { min-height:var(--tap-min); }
  .rc-devices__rename button { width:var(--tap-min); }
}
`;
