import { initGlyphHero } from "./glyph-hero";
import { initScroll } from "./scroll";
import { initPlayground } from "./playground";
import { isAccountShellPath, mountAccountShell } from "./app-shell";
import { isPublicDocumentPath, mountPublicDocument } from "./public-documents";
import { revealHostedAccountEntries } from "./product-capabilities";

if (isPublicDocumentPath(window.location.pathname)) {
  mountPublicDocument(window.location.pathname);
} else if (isAccountShellPath(window.location.pathname)) {
  mountAccountShell();
} else {
  // Account-creation CTAs are hidden in static HTML and appear only after the versioned
  // control-plane contract explicitly advertises a compatible hosted account launch.
  void revealHostedAccountEntries(document);

  // Hero field (atmosphere; static composition remains without it)
  const canvas = document.getElementById("glyphs") as HTMLCanvasElement | null;
  const hero = canvas ? initGlyphHero(canvas) : null;
  // Debug beacon: which hero path is live ("gl" = WebGL field, "static" = fallback). Harmless in prod,
  // lets a headless check assert the field actually initialized on real hardware.
  document.documentElement.dataset.hero = hero ? "gl" : "static";

  initScroll({ onHeroProgress: (p) => hero?.setScroll(p) });
  initPlayground();

  // Copy-to-clipboard on both command pills (the installer independently probes Claude Code and Codex)
  const CMD = "curl -fsSL https://roamcode.ai/install | bash";
  for (const id of ["copy-hero", "copy-install"]) {
    const btn = document.getElementById(id);
    btn?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(CMD);
      } catch {
        /* clipboard blocked — label still flips as feedback */
      }
      const tag = btn.querySelector<HTMLElement>(".copy");
      if (!tag) return;
      tag.textContent = "copied ✓";
      tag.classList.add("ok");
      setTimeout(() => {
        tag.textContent = "copy";
        tag.classList.remove("ok");
      }, 1600);
    });
  }

  // Live GitHub stars (worker-cached; quiet fallback text stays if anything fails)
  void (async () => {
    try {
      const r = await fetch("/api/stars");
      if (!r.ok) return;
      const { stars } = (await r.json()) as { stars?: number };
      if (typeof stars !== "number") return;
      const n = document.getElementById("stars-n");
      if (n) n.textContent = stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars);
    } catch {
      /* offline or blocked — keep the static label */
    }
  })();
}
