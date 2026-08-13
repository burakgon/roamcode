import { useMemo, useState } from "react";
import {
  GHOSTTY_THEMES,
  GHOSTTY_THEME_SOURCE,
  type GhosttyThemeDefinition,
} from "../appearance/ghostty-themes.generated";
import { TERMINAL_FONTS, loadTerminalFont, setTerminalFont } from "../appearance/terminal-fonts";
import { loadOled, loadTheme, ROAMCODE_THEME, setOled, setTheme } from "../pwa/theme";

const APPEARANCE_THEMES: readonly GhosttyThemeDefinition[] = [ROAMCODE_THEME, ...GHOSTTY_THEMES];

const FEATURED = new Set([
  "RoamCode Dark",
  "Ghostty Default Style Dark",
  "Catppuccin Mocha",
  "Dracula",
  "TokyoNight",
  "TokyoNight Storm",
  "One Dark Two",
  "Gruvbox Dark",
  "Kanagawa Wave",
  "Rose Pine",
  "Nord",
  "iTerm2 Solarized Dark",
  "Ayu Mirage",
]);

function ThemePreview({ theme }: { theme: GhosttyThemeDefinition }) {
  const palette = theme.palette;
  return (
    <span className="rc-appearance__preview" style={{ background: theme.background, color: theme.foreground }}>
      <span style={{ color: palette[10] }}>$</span> <span style={{ color: palette[14] }}>pnpm</span>{" "}
      <span style={{ color: palette[11] }}>test</span>
      <i>
        <span style={{ background: palette[1] }} />
        <span style={{ background: palette[2] }} />
        <span style={{ background: palette[4] }} />
        <span style={{ background: palette[5] }} />
        <span style={{ background: palette[6] }} />
      </i>
    </span>
  );
}

export function AppearanceSettings() {
  const [theme, setThemeState] = useState(loadTheme);
  const [oled, setOledState] = useState(loadOled);
  const [fontId, setFontId] = useState(() => loadTerminalFont().id);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const normalized = query.trim().toLocaleLowerCase();
  const themes = useMemo(() => {
    if (normalized) return APPEARANCE_THEMES.filter((item) => item.name.toLocaleLowerCase().includes(normalized));
    if (showAll) return APPEARANCE_THEMES;
    return APPEARANCE_THEMES.filter((item) => FEATURED.has(item.name));
  }, [normalized, showAll]);

  return (
    <div className="rc-appearance">
      <div className="rc-appearance__field-row">
        <label className="rc-settings__field">
          <span className="rc-settings__field-label">Terminal font</span>
          <select
            className="rc-settings__control rc-appearance__font-select"
            aria-label="Terminal font"
            value={fontId}
            style={{ fontFamily: TERMINAL_FONTS.find((entry) => entry.id === fontId)?.stack }}
            onChange={(event) => {
              const selected = setTerminalFont(event.target.value);
              setFontId(selected.id);
            }}
          >
            {TERMINAL_FONTS.map((entry) => (
              <option key={entry.id} value={entry.id} style={{ fontFamily: entry.stack }}>
                {entry.name} — Il1 0O {} =&gt;
              </option>
            ))}
          </select>
          <small className="rc-settings__hint">
            {TERMINAL_FONTS.length} bundled developer fonts; changes apply to the open terminal.
          </small>
        </label>
        <label className="rc-appearance__oled">
          <input
            type="checkbox"
            aria-label="OLED true black"
            checked={oled}
            onChange={(event) => {
              setOledState(event.target.checked);
              setOled(event.target.checked);
            }}
          />
          <span>
            <strong>OLED black</strong>
            <small>Keep the selected palette with pure-black backgrounds.</small>
          </span>
        </label>
      </div>

      <div className="rc-appearance__theme-head">
        <label>
          <span className="rc-settings__field-label">Ghostty themes</span>
          <input
            className="rc-settings__control"
            type="search"
            aria-label="Search Ghostty themes"
            placeholder={`Search ${GHOSTTY_THEMES.length} themes…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {!normalized && (
          <button type="button" className="rc-appearance__all" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Featured" : `All ${GHOSTTY_THEMES.length}`}
          </button>
        )}
      </div>

      <div className="rc-appearance__themes" role="listbox" aria-label="Ghostty themes">
        {themes.map((item) => (
          <button
            key={item.name}
            type="button"
            role="option"
            aria-selected={theme === item.name}
            className={`rc-appearance__theme${theme === item.name ? " is-selected" : ""}`}
            onClick={() => {
              const selected = setTheme(item);
              setThemeState(selected);
            }}
          >
            <ThemePreview theme={item} />
            <span>{item.name}</span>
          </button>
        ))}
        {themes.length === 0 && <p className="rc-appearance__empty">No matching Ghostty theme.</p>}
      </div>
      <p className="rc-settings__hint rc-appearance__source">
        Complete Ghostty catalog · official snapshot {GHOSTTY_THEME_SOURCE.sourceDate} · simple live previews
      </p>
    </div>
  );
}

export const appearanceSettingsCss = `
.rc-appearance { display:grid; gap:12px; }
.rc-appearance__field-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(190px,.72fr); gap:10px; align-items:end; }
.rc-appearance__font-select { font-family:var(--terminal-font); }
.rc-appearance__oled { min-height:44px; display:flex; align-items:center; gap:9px; padding:8px 10px; border:1px solid var(--border); background:var(--surface-2); }
.rc-appearance__oled input { width:18px; height:18px; flex:none; accent-color:var(--coral); }
.rc-appearance__oled span { min-width:0; display:grid; gap:2px; }.rc-appearance__oled strong { font-size:12px; }.rc-appearance__oled small { color:var(--text-muted); font-size:10px; line-height:1.3; }
.rc-appearance__theme-head { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:8px; }
.rc-appearance__theme-head label { display:grid; gap:6px; }.rc-appearance__theme-head input { width:100%; }
.rc-appearance__all { min-height:var(--control-h); padding:0 10px; border:1px solid var(--border); background:var(--surface-2); color:var(--text); cursor:pointer; font:600 11px/1 var(--font-mono); }
.rc-appearance__themes { max-height:360px; overflow:auto; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:5px; padding-right:2px; }
.rc-appearance__theme { min-width:0; padding:4px; display:grid; gap:5px; border:1px solid var(--border); background:var(--surface); color:var(--text); cursor:pointer; text-align:left; }
.rc-appearance__theme > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 2px 2px; color:var(--text-muted); font:600 9px/1.2 var(--font-mono); }
.rc-appearance__theme.is-selected { border-color:var(--coral); box-shadow:inset 0 0 0 1px var(--coral); }.rc-appearance__theme.is-selected > span:last-child { color:var(--text); }
.rc-appearance__preview { height:40px; overflow:hidden; display:flex; align-items:center; padding:0 7px; border:1px solid rgba(127,127,127,.22); font:400 9px/1.2 var(--terminal-font); white-space:nowrap; }
.rc-appearance__preview i { margin-left:auto; display:flex; gap:2px; }.rc-appearance__preview i span { width:5px; height:5px; border-radius:50%; }
.rc-appearance__empty { grid-column:1/-1; margin:0; padding:18px; border:1px solid var(--border); color:var(--text-muted); text-align:center; font-size:12px; }
.rc-appearance__source { margin:0; text-align:right; }
@media (max-width:700px) { .rc-appearance__field-row { grid-template-columns:1fr; }.rc-appearance__themes { grid-template-columns:repeat(2,minmax(0,1fr)); max-height:42vh; } }
`;
