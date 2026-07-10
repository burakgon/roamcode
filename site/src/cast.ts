/**
 * The playground replay script — a hand-authored claude session with real pacing.
 * ANSI truecolor matches the site palette; the playground engine interprets frames:
 *   line — write + newline after delay
 *   type — human-typed input, written char by char
 *   spin — in-place spinner (cycling glyphs + climbing token counter), then the line clears
 */

const CORAL = "\x1b[38;2;247;122;68m";
const DIM = "\x1b[38;2;147;147;156m";
const FAINT = "\x1b[38;2;85;85;94m";
const GREEN = "\x1b[38;2;124;227;139m";
const R = "\x1b[0m";

export type Frame =
  | { t: "line"; s: string; d: number }
  | { t: "type"; s: string; d: number }
  | { t: "spin"; label: string; ms: number; fromK: number; toK: number };

export const PROMPT = `${CORAL}❯${R} `;

export const CAST: Frame[] = [
  { t: "line", s: `${CORAL}✳ Welcome to Claude Code!${R}`, d: 300 },
  { t: "line", s: "", d: 150 },
  { t: "type", s: "the payments webhook is timing out in prod — find it, fix it", d: 420 },
  { t: "line", s: `${DIM}⏺ I'll look at the webhook handler first.${R}`, d: 800 },
  { t: "spin", label: "Reading", ms: 1500, fromK: 0.3, toK: 1.2 },
  { t: "line", s: `${DIM}⏺ Read(src/webhooks/payments.ts)${R} ${FAINT}⎿ 214 lines${R}`, d: 500 },
  { t: "line", s: `${DIM}⏺ Found it — a 30s retry loop runs inline in the request handler.${R}`, d: 950 },
  { t: "line", s: `${DIM}  Moving it to the job queue…${R}`, d: 500 },
  { t: "spin", label: "Refactoring", ms: 2100, fromK: 1.4, toK: 4.8 },
  { t: "line", s: `${DIM}⏺ Edit(src/webhooks/payments.ts)${R} ${GREEN}+18${R} ${CORAL}-6${R}`, d: 700 },
  { t: "spin", label: "Testing", ms: 1700, fromK: 4.9, toK: 6.2 },
  { t: "line", s: `${DIM}⏺ Bash(pnpm test webhooks)${R} ${GREEN}✓ 12 passed${R}`, d: 600 },
  { t: "line", s: "", d: 150 },
  { t: "line", s: `${GREEN}✓ Fixed.${R} ${DIM}The retry loop now drains through the job queue —${R}`, d: 400 },
  { t: "line", s: `${DIM}  p95 back under 300ms.${R}`, d: 300 },
  { t: "line", s: "", d: 200 },
];

/** In-character canned replies for the typeable prompt, rotated per submission. */
export function reply(n: number): string[] {
  const cmd = `${CORAL}→${R} curl -fsSL https://roamcode.ai/install | bash`;
  switch (n % 3) {
    case 0:
      return [
        `${DIM}⏺ This is a replay — the real one runs on ${R}your${DIM} machine,${R}`,
        `${DIM}  on your Claude subscription.${R}`,
        cmd,
      ];
    case 1:
      return [`${DIM}⏺ Nice try. This page has no shell — your Mac will, in about sixty seconds.${R}`, cmd];
    default:
      return [`${DIM}⏺ Everything else lives in the README:${R}`, `${CORAL}→${R} github.com/burakgon/roamcode`];
  }
}
