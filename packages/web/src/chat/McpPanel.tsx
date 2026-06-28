import { useEffect, useRef } from "react";
import { Mono } from "../ui/Mono";
import { Icon } from "../ui/Icon";
import { useFocusTrap } from "../ui/useFocusTrap";
import { deriveMcpServers } from "./mcp";

export interface McpPanelProps {
  /** The session's available tool names (from `system/init`) — built-ins + `mcp__<server>__<tool>`. The
   *  panel derives the MCP servers from these; undefined/empty → the empty state. */
  tools?: string[];
  onClose: () => void;
}

/**
 * MCP VISIBILITY PANEL — the phone's read-only `/mcp` listing. Reuses the Settings sheet pattern (a
 * focus-trapped, Escape-dismissable, full-bleed mobile sheet / centered card on desktop). Lists each
 * configured MCP server and the tools it exposes, derived from the session's tool list. Read-only: parity
 * with the terminal `/mcp`'s listing, no actions.
 */
export function McpPanel({ tools, onClose }: McpPanelProps) {
  const servers = deriveMcpServers(tools);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Real modal semantics: trap Tab within the sheet, restore focus to the trigger on close.
  useFocusTrap(dialogRef);

  // Escape closes the sheet, matching SettingsPanel / DirectoryPicker.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toolCount = servers.reduce((n, s) => n + s.tools.length, 0);

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="MCP servers" className="rc-mcp">
      <section className="rc-mcp__card">
        <header className="rc-mcp__head">
          <span className="rc-mcp__head-id">
            <span className="rc-mcp__head-icon" aria-hidden="true">
              <Icon name="sliders" size={18} />
            </span>
            <strong className="display rc-mcp__title">MCP servers</strong>
          </span>
          <button type="button" className="rc-mcp__close" onClick={onClose} aria-label="Close MCP servers">
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="rc-mcp__body">
          {servers.length === 0 ? (
            <p className="rc-mcp__empty">No MCP servers are configured for this session.</p>
          ) : (
            <>
              <p className="rc-mcp__summary">
                {servers.length} {servers.length === 1 ? "server" : "servers"} · {toolCount}{" "}
                {toolCount === 1 ? "tool" : "tools"}
              </p>
              <ul className="rc-mcp__list">
                {servers.map((server) => (
                  <li key={server.name} className="rc-mcp__server">
                    <div className="rc-mcp__server-head">
                      <span className="rc-mcp__server-icon" aria-hidden="true">
                        <Icon name="terminal" size={14} />
                      </span>
                      <Mono>{server.name}</Mono>
                      <span className="rc-mcp__server-count">
                        {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
                      </span>
                    </div>
                    <ul className="rc-mcp__tools">
                      {server.tools.map((tool) => (
                        <li key={tool} className="rc-mcp__tool">
                          <Mono muted>{tool}</Mono>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="rc-mcp__note">Read-only — this lists the MCP servers and tools available to claude.</p>
        </div>
      </section>

      <style>{mcpCss}</style>
    </div>
  );
}

const mcpCss = `
.rc-mcp {
  position: fixed; inset: 0; z-index: 50;
  background-color: var(--bg);
  background-image: var(--top-glow);
  display: grid; place-items: center;
  padding: var(--sp-5);
  overflow-y: auto;
}
.rc-mcp__card {
  width: min(92vw, 480px);
  display: flex; flex-direction: column;
  max-height: min(86vh, calc(100dvh - 2 * var(--sp-5)));
  background: var(--glass-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-shadow);
  overflow: hidden;
}
.rc-mcp__head {
  flex: none;
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.rc-mcp__head-id { display: flex; align-items: center; gap: var(--sp-2); }
.rc-mcp__head-icon { color: var(--text-muted); display: grid; place-items: center; }
.rc-mcp__title { font-size: var(--fs-lg); }
.rc-mcp__close {
  width: var(--tap-min); height: var(--tap-min); flex: none;
  display: grid; place-items: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-muted); border-radius: var(--radius);
  transition: color 120ms ease, background 120ms ease;
}
.rc-mcp__close:hover { color: var(--text); background: var(--surface-2); }
.rc-mcp__body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: var(--sp-4);
  padding-bottom: calc(var(--sp-4) + env(safe-area-inset-bottom, 0px));
  display: grid; gap: var(--sp-3);
}
.rc-mcp__summary { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); font-family: var(--font-mono); }
.rc-mcp__empty { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5; }
.rc-mcp__list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-3); }
.rc-mcp__server {
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); box-shadow: var(--shadow-1);
  overflow: hidden;
}
.rc-mcp__server-head {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.rc-mcp__server-icon { color: var(--text-muted); display: grid; place-items: center; flex: none; }
.rc-mcp__server-count {
  margin-left: auto; flex: none;
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-faint);
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 999px; padding: 1px var(--sp-2);
}
.rc-mcp__tools { list-style: none; margin: 0; padding: var(--sp-1) 0; }
.rc-mcp__tool {
  display: flex; align-items: center; min-height: 32px;
  padding: 0 var(--sp-3) 0 calc(var(--sp-3) + 22px);
}
.rc-mcp__note { color: var(--text-faint); font-size: var(--fs-xs); margin: 0; line-height: 1.5; }
`;
