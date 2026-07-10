/**
 * Scroll orchestration: Lenis smooth scroll, hero dissolve progress, section reveals,
 * beat word-by-word reveal, scroll-linked scene depth, typed H1, spinner glyph cycling,
 * top-bar state. One rAF, a couple of IntersectionObservers — no animation framework.
 */
import Lenis from "lenis";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initScroll(hooks: { onHeroProgress(p: number): void }): void {
  // ---- smooth scroll (skipped under reduced motion; native scroll still works everywhere)
  if (!reduced) {
    const lenis = new Lenis({ lerp: 0.11 });
    document.documentElement.classList.add("lenis");
    const raf = (t: number) => {
      lenis.raf(t);
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
    // Lenis owns the scroll position, so native anchor jumps get overridden — route them through it.
    document.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
      if (!a) return;
      const el = document.querySelector(a.hash);
      if (!el) return;
      e.preventDefault();
      lenis.scrollTo(el as HTMLElement, { offset: -12 });
      history.pushState(null, "", a.hash);
    });
    if (location.hash) {
      const el = document.querySelector(location.hash);
      if (el) lenis.scrollTo(el as HTMLElement, { immediate: true, offset: -12 });
    }
  }

  // ---- top bar + hero progress (single scroll listener)
  const bar = document.getElementById("bar")!;
  const hero = document.getElementById("hero")!;
  const onScroll = () => {
    bar.classList.toggle("scrolled", scrollY > 30);
    hooks.onHeroProgress(Math.min(1, Math.max(0, scrollY / (hero.offsetHeight * 0.85))));
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // ---- .rv reveals
  const io = new IntersectionObserver(
    (es) => {
      for (const e of es)
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
    },
    { threshold: 0.18 },
  );
  document.querySelectorAll(".rv").forEach((el) => io.observe(el));

  // ---- beat: wrap every word (inside <b>/<span> too) and stagger the reveal
  const beat = document.getElementById("beat");
  if (beat) {
    let wi = 0;
    const wrapWords = (node: Node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          for (const part of (child.textContent ?? "").split(/(\s+)/)) {
            if (/^\s+$/.test(part) || part === "") {
              frag.appendChild(document.createTextNode(part));
              continue;
            }
            const s = document.createElement("span");
            s.className = "w";
            s.textContent = part;
            s.style.transitionDelay = `${wi++ * 90}ms`;
            frag.appendChild(s);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) wrapWords(child);
      }
    };
    wrapWords(beat);
    new IntersectionObserver(
      (es, o) => {
        if (es[0]?.isIntersecting) {
          beat.classList.add("in");
          o.disconnect();
        }
      },
      { threshold: 0.5 },
    ).observe(beat);
  }

  // ---- scroll-linked scene depth: rotation deepens toward viewport edges, eases at center
  const stages = [...document.querySelectorAll<HTMLElement>(".scene .tilt")];
  if (stages.length && !reduced) {
    const tick = () => {
      const vh = innerHeight;
      for (const el of stages) {
        const r = el.getBoundingClientRect();
        const norm = (r.top + r.height / 2 - vh / 2) / vh; // -0.5 top … +0.5 bottom
        const even = el.closest(".scene:nth-child(even)") !== null;
        const base = even ? 9 : -9;
        el.style.setProperty("--ry", `${base + norm * (even ? 10 : -10)}deg`);
        el.style.setProperty("--rx", `${2 + norm * 6}deg`);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---- typed H1
  const h1t = document.getElementById("h1t");
  if (h1t) {
    const text = (h1t.dataset.text ?? "").replace(/\\n/g, "\n");
    if (reduced) h1t.textContent = text;
    else {
      let i = 0;
      const type = () => {
        h1t.textContent = text.slice(0, ++i);
        if (i < text.length) setTimeout(type, text[i - 1] === "\n" ? 340 : 38 + Math.random() * 48);
      };
      setTimeout(type, 350);
    }
  }

  // ---- spinner glyphs inside product replicas (the real claude cadence)
  if (!reduced) {
    const SPIN = ["✳", "✻", "✽", "·"];
    const spinners = [...document.querySelectorAll<HTMLElement>(".spin")];
    let si = 0;
    setInterval(() => {
      si++;
      spinners.forEach((el, j) => {
        el.textContent = SPIN[(si + j) % SPIN.length]!;
      });
    }, 260);
  }
}
