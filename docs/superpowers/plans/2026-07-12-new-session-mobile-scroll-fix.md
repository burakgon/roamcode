# New Session Mobile Scroll Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the long provider-aware new-session form scroll inside its modal on iOS without moving the application layer underneath.

**Architecture:** Reuse the proven Settings/DirectoryPicker structure: the backdrop-filtered card becomes a bounded, non-scrolling flex shell and its existing body becomes the sole vertical scroll owner. Keep the change CSS-only so the wizard's provider, focus, keyboard, dismissal, and submission behavior remains unchanged.

**Tech Stack:** React, TypeScript, CSS, Vitest, Testing Library, Vite PWA.

## Global Constraints

- Keep `.rc-wizard` as the fixed full-viewport scrim.
- Keep the existing responsive width, maximum height, glass styling, spacing, controls, focus trap, Escape, backdrop dismissal, and provider selection behavior.
- `.rc-wizard__card` is a bounded flex-column shell with `overflow: hidden` and is not the vertical scroll owner.
- `.rc-wizard__body` is the only vertical scroll owner and uses `flex: 1`, `min-height: 0`, `overflow-y: auto`, `-webkit-overflow-scrolling: touch`, and `overscroll-behavior-y: contain`.
- Do not add JavaScript document/body scroll locking or change global viewport/keyboard handling.
- Write and observe a focused failing regression before changing production CSS.

---

### Task 1: Move wizard scrolling from the glass card to its body

**Files:**
- Modify: `packages/web/src/session/NewSessionWizard.tsx`
- Modify: `packages/web/src/session/NewSessionWizard.test.tsx`

**Interfaces:**
- Consumes: the existing `.rc-wizard`, `.rc-wizard__card`, and `.rc-wizard__body` DOM structure.
- Produces: a computed-style scroll contract in which the card clips and the body owns contained iOS scrolling.

- [ ] **Step 1: Add the failing mobile scroll-contract regression**

Append this test inside `describe("NewSessionWizard provider choice", ...)`:

```tsx
test("keeps long Codex settings inside the modal's iOS scroll container", async () => {
  const { container } = renderWizard();
  await userEvent.click(screen.getByRole("radio", { name: /codex/i }));

  const card = container.querySelector<HTMLElement>(".rc-wizard__card");
  const body = container.querySelector<HTMLElement>(".rc-wizard__body");
  expect(card).not.toBeNull();
  expect(body).not.toBeNull();

  const cardStyle = getComputedStyle(card!);
  const bodyStyle = getComputedStyle(body!);
  expect(cardStyle.display).toBe("flex");
  expect(cardStyle.flexDirection).toBe("column");
  expect(cardStyle.overflow).toBe("hidden");
  expect(bodyStyle.flexGrow).toBe("1");
  expect(bodyStyle.minHeight).toBe("0px");
  expect(bodyStyle.overflowY).toBe("auto");
  expect(bodyStyle.getPropertyValue("-webkit-overflow-scrolling")).toBe("touch");
  expect(bodyStyle.getPropertyValue("overscroll-behavior-y")).toBe("contain");
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm vitest run packages/web/src/session/NewSessionWizard.test.tsx
```

Expected: FAIL because the card is not a flex shell, still owns `overflow-y: auto`, and the body lacks the required scroll properties.

- [ ] **Step 3: Apply the minimal Settings-style CSS ownership change**

Change only the relevant rules in `wizardCss`:

```css
.rc-wizard__card {
  width: min(92vw, 460px);
  max-height: calc(100dvh - 2 * var(--sp-5));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* retain every existing glass, border, radius, and shadow declaration */
}
.rc-wizard__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: var(--sp-5);
  display: grid;
  gap: var(--sp-4);
}
```

Do not add event handlers, document/body mutations, new wrappers, sticky controls, or global CSS.

- [ ] **Step 4: Run focused GREEN and adjacent web regressions**

Run:

```bash
pnpm vitest run packages/web/src/session/NewSessionWizard.test.tsx packages/web/src/providers/provider-options.test.tsx packages/web/src/App.test.tsx packages/web/src/pwa/viewport.test.ts
```

Expected: PASS, including the new computed-style contract and every existing provider/session behavior.

- [ ] **Step 5: Run quality checks and commit**

Run:

```bash
pnpm typecheck
pnpm eslint packages/web/src/session/NewSessionWizard.tsx packages/web/src/session/NewSessionWizard.test.tsx
pnpm prettier --check packages/web/src/session/NewSessionWizard.tsx packages/web/src/session/NewSessionWizard.test.tsx
git diff --check
```

Then commit:

```bash
git add packages/web/src/session/NewSessionWizard.tsx packages/web/src/session/NewSessionWizard.test.tsx
git commit -m "fix: contain mobile wizard scrolling"
```

---

## Release Verification

After task review approval:

1. Build and run the local app from this worktree.
2. Use an iPhone-sized viewport and open the prefilled new-session wizard.
3. Select Codex and verify the modal body scrolls from the provider cards through all Codex options to **Start session** and **Cancel**.
4. Verify the application layer under the scrim does not move and Settings still scrolls.
5. Run `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `git diff --check origin/main...HEAD`.
6. Request a broad independent review, squash onto fresh `origin/main`, repeat release verification, and push normally to `main`.
