// Screenshot harness entry — dev/tooling only (never referenced by index.html, so it never ships). Renders a
// single scene chosen by `?scene=` at full-viewport height. Regenerate images: node packages/web/scripts/shots.mjs
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { SCENES } from "./scenes";

document.documentElement.style.setProperty("--app-height", "100vh");
const scene = new URLSearchParams(location.search).get("scene") ?? "terminal";
const render = SCENES[scene];
createRoot(document.getElementById("root")!).render(
  render ? (
    render()
  ) : (
    <div style={{ color: "#fff", padding: 24, fontFamily: "sans-serif" }}>unknown scene: {scene}</div>
  ),
);
