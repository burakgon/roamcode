/**
 * The Assembly — raw WebGL2 glyph field. Thousands of terminal glyphs drift in from scattered
 * space and converge into the silhouette of a claude TUI frame behind the headline; scrolling
 * past the hero blows them apart again (velocity away from center + fade). No 3D library —
 * one instanced quad, one atlas texture, ~300 lines, all bespoke.
 *
 * Returns null when WebGL2 is unavailable or the user prefers reduced motion — the caller
 * simply keeps the static hero (the DOM copy is the composition; the field is atmosphere).
 */

export interface GlyphHero {
  setScroll(p: number): void; // 0 = hero fully in view, 1 = scrolled past
  destroy(): void;
}

const GLYPHS = ["│", "─", "█", "❯", "⏺", "✳", "·", "▛", "▜", "↓", "+", "▁"] as const;
const CELL = 64; // atlas cell px

function buildAtlas(): { canvas: HTMLCanvasElement; cols: number; rows: number } {
  const cols = 4, rows = 3;
  const c = document.createElement("canvas");
  c.width = cols * CELL; c.height = rows * CELL;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "#ffffff";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `${CELL * 0.72}px ui-monospace, Menlo, monospace`;
  GLYPHS.forEach((ch, i) => {
    const x = (i % cols) * CELL + CELL / 2, y = Math.floor(i / cols) * CELL + CELL / 2;
    g.fillText(ch, x, y);
  });
  return { canvas: c, cols, rows };
}

/** Character-cell homes forming a TUI silhouette: border, title, content lines, prompt. */
function tuiHomes(w: number, h: number): Array<{ x: number; y: number; glyph: number; tint: number; size: number }> {
  const out: Array<{ x: number; y: number; glyph: number; tint: number; size: number }> = [];
  const COLS = 56, ROWS = 20;
  const cw = Math.min(w * 0.86, 980) / COLS;
  const ch = cw * 1.9;
  const x0 = (w - COLS * cw) / 2, y0 = (h - ROWS * ch) / 2;
  const G = (ch2: (typeof GLYPHS)[number]) => GLYPHS.indexOf(ch2);
  const rand = (a: number[]) => a[Math.floor(Math.random() * a.length)]!;
  // content line lengths (cols), sparse like a real transcript
  const lines: Record<number, number> = { 3: 38, 4: 44, 5: 30, 7: 41, 8: 26, 10: 36, 12: 18 };
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const border = r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1;
      const title = r === 1 && c >= 2 && c <= 16;
      const body = lines[r] !== undefined && c >= 2 && c < 2 + (lines[r] ?? 0) && Math.random() < 0.82;
      const prompt = r === ROWS - 3 && c >= 2 && c <= 3;
      if (!border && !title && !body && !prompt) continue;
      // thin the border so it reads as a frame, not a wall
      if (border && Math.random() < 0.35) continue;
      let glyph: number, tint = 0, size = 1;
      if (border) glyph = r === 0 || r === ROWS - 1 ? G("─") : G("│");
      else if (title) { glyph = G("·"); tint = 0.25; }
      else if (prompt) { glyph = c === 2 ? G("❯") : G("▁"); tint = 1; size = 1.25; }
      else { glyph = rand([G("█"), G("⏺"), G("·"), G("✳"), G("+"), G("↓"), G("▁")]); tint = Math.random() < 0.12 ? 1 : 0; }
      out.push({ x: x0 + c * cw + cw / 2, y: y0 + r * ch + ch / 2, glyph, tint, size });
    }
  }
  return out;
}

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;   // quad corner (-.5..+.5)
layout(location=1) in vec2 aStart;
layout(location=2) in vec2 aHome;
layout(location=3) in float aDelay;
layout(location=4) in float aSize;
layout(location=5) in float aTint;
layout(location=6) in float aGlyph;
layout(location=7) in float aPhase;
uniform vec2 uRes;
uniform float uTime;
uniform float uScroll;
uniform vec2 uMouse;      // -1..1, lerped
uniform vec2 uAtlas;      // atlas cols/rows
out vec2 vUV;
out float vAlpha;
out float vTint;
void main() {
  float t = clamp((uTime - aDelay) / 2600.0, 0.0, 1.0);
  float e = 1.0 - pow(1.0 - t, 3.0);                       // easeOutCubic assemble
  vec2 pos = mix(aStart, aHome, e);
  pos += vec2(sin(uTime/1700.0 + aPhase), cos(uTime/2100.0 + aPhase*1.3)) * 5.0;
  pos += uMouse * (6.0 + aSize * 10.0);                    // parallax: bigger glyph = nearer = moves more
  vec2 dir = normalize(aHome - uRes * 0.5 + vec2(0.0001));
  float blow = uScroll * uScroll;
  pos += dir * blow * (240.0 + aSize * 260.0) + vec2(0.0, blow * 120.0);
  float sz = aSize * (13.0 + 6.0 * aTint);
  vec2 corner = aCorner * sz;
  vec2 clip = ((pos + corner) / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float col = mod(aGlyph, uAtlas.x);
  float row = floor(aGlyph / uAtlas.x);
  vUV = (vec2(col, row) + (aCorner + 0.5)) / uAtlas;
  vAlpha = (0.17 + 0.30 * aTint + 0.10 * sin(uTime/900.0 + aPhase*2.0)) * e * (1.0 - blow);
  vTint = aTint;
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
in float vAlpha;
in float vTint;
out vec4 o;
void main() {
  float a = texture(uTex, vUV).a * vAlpha;
  vec3 grey = vec3(0.604, 0.604, 0.635);
  vec3 coral = vec3(0.969, 0.478, 0.267);
  o = vec4(mix(grey, coral, vTint) * a, a); // premultiplied — matches canvas compositing
}`;

export function initGlyphHero(canvas: HTMLCanvasElement): GlyphHero | null {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  let prog: WebGLProgram;
  try {
    prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  } catch {
    return null; // any GL hiccup → static hero, never a broken page
  }
  gl.useProgram(prog);

  // atlas texture
  const atlas = buildAtlas();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // static quad
  const quad = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const qbuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, qbuf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const ibuf = gl.createBuffer();
  let count = 0;

  const U = (n: string) => gl.getUniformLocation(prog, n);
  const uRes = U("uRes"), uTime = U("uTime"), uScroll = U("uScroll"), uMouse = U("uMouse"), uAtlas = U("uAtlas");
  gl.uniform2f(uAtlas, atlas.cols, atlas.rows);
  gl.uniform1i(U("uTex"), 0);

  function rebuild() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = w * dpr; canvas.height = h * dpr;
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.uniform2f(uRes, w, h);

    const homes = tuiHomes(w, h);
    const isMobile = w < 720;
    const max = isMobile ? 700 : 1900;
    const chosen = homes.length > max ? homes.filter(() => Math.random() < max / homes.length) : homes;
    count = chosen.length;
    // interleaved per-instance: start(2) home(2) delay(1) size(1) tint(1) glyph(1) phase(1) = 9 floats
    const data = new Float32Array(count * 9);
    chosen.forEach((p, i) => {
      const a = Math.random() * Math.PI * 2;
      const r = Math.max(w, h) * (0.55 + Math.random() * 0.6);
      let o = i * 9;
      data[o++] = w / 2 + Math.cos(a) * r;             // scattered start, off-screen ring
      data[o++] = h / 2 + Math.sin(a) * r;
      data[o++] = p.x; data[o++] = p.y;
      data[o++] = Math.random() * 1100;                 // delay ms
      data[o++] = p.size * (0.8 + Math.random() * 0.5);
      data[o++] = p.tint;
      data[o++] = p.glyph;
      data[o++] = Math.random() * Math.PI * 2;
    });
    gl!.bindBuffer(gl!.ARRAY_BUFFER, ibuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.STATIC_DRAW);
    const stride = 9 * 4;
    const attr = (loc: number, size: number, off: number) => {
      gl!.enableVertexAttribArray(loc);
      gl!.vertexAttribPointer(loc, size, gl!.FLOAT, false, stride, off * 4);
      gl!.vertexAttribDivisor(loc, 1);
    };
    attr(1, 2, 0); attr(2, 2, 2); attr(3, 1, 4); attr(4, 1, 5); attr(5, 1, 6); attr(6, 1, 7); attr(7, 1, 8);
  }

  rebuild();
  const ro = new ResizeObserver(rebuild);
  ro.observe(canvas);

  // lerped mouse parallax
  let mx = 0, my = 0, tmx = 0, tmy = 0;
  const onMove = (e: PointerEvent) => {
    tmx = (e.clientX / innerWidth) * 2 - 1;
    tmy = (e.clientY / innerHeight) * 2 - 1;
  };
  addEventListener("pointermove", onMove, { passive: true });

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied source

  let scroll = 0, raf = 0, dead = false;
  const t0 = performance.now();
  const frame = (now: number) => {
    if (dead) return;
    if (scroll < 0.999) { // fully dissolved → skip draws, keep rAF cheap
      mx += (tmx - mx) * 0.06; my += (tmy - my) * 0.06;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, now - t0);
      gl.uniform1f(uScroll, scroll);
      gl.uniform2f(uMouse, mx * 14, my * 10);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    setScroll(p) { scroll = Math.min(1, Math.max(0, p)); },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("pointermove", onMove);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
