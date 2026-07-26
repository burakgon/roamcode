// Screenshot harness entry — dev/tooling only (never referenced by index.html, so it never ships). Renders a
// single scene chosen by `?scene=` at full-viewport height. Regenerate images: node packages/web/scripts/shots.mjs
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { installViewportSync } from "../pwa/viewport";
import { SCENES } from "./scenes";

// Use the same visual-viewport geometry as production. This lets the real-browser mobile suite inject iOS
// keyboard shrink + pan events and catch regressions that a fixed 100vh screenshot harness would hide.
installViewportSync();
const params = new URLSearchParams(location.search);
const safeBottomParam = params.get("safeBottom");
if (safeBottomParam !== null) {
  const safeBottom = Number(safeBottomParam);
  if (Number.isFinite(safeBottom) && safeBottom >= 0) {
    document.documentElement.style.setProperty("--safe-area-bottom", `${safeBottom}px`);
  }
}
const scene = params.get("scene") ?? "terminal";
const render = SCENES[scene];
createRoot(document.getElementById("root")!).render(
  render ? (
    render()
  ) : (
    <div style={{ color: "#fff", padding: 24, fontFamily: "sans-serif" }}>unknown scene: {scene}</div>
  ),
);
