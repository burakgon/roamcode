# New Session Mobile Scroll Fix Design

**Date:** 2026-07-12
**Status:** Approved

## Problem

The provider-aware new-session form is taller than a phone viewport, especially after selecting Codex. On iOS,
the wizard currently makes the same element both the backdrop-filtered glass card and the `overflow-y: auto`
scroll container. Touch panning can fail to move that composited element and instead chain to the application
shell underneath, leaving lower form controls unreachable.

The Settings panel on the same device scrolls correctly because it uses a different structure: a bounded,
backdrop-filtered card is a non-scrolling flex shell, while a child body with `min-height: 0` owns vertical
scrolling.

## Design

Apply the established Settings/DirectoryPicker scroll pattern to `NewSessionWizard`:

- keep `.rc-wizard` as the fixed full-viewport scrim;
- make `.rc-wizard__card` a bounded flex-column shell with `overflow: hidden`;
- make `.rc-wizard__body` the only vertical scroll owner with `flex: 1`, `min-height: 0`, and
  `overflow-y: auto`;
- enable iOS momentum scrolling with `-webkit-overflow-scrolling: touch`;
- stop scroll chaining at the body boundary with `overscroll-behavior-y: contain`;
- retain the existing responsive width, maximum height, glass styling, spacing, controls, focus trap, Escape,
  backdrop dismissal, and provider selection behavior.

No JavaScript body-position lock will be introduced. That approach is unnecessary once the modal owns its
scroll and risks conflicting with the existing iOS visual-viewport and keyboard handling.

## Testing

- Add a focused regression in `NewSessionWizard.test.tsx` that renders the long Codex form and verifies the
  card/body computed scroll contract: bounded hidden shell, child vertical scroll owner, momentum scrolling,
  and contained overscroll.
- Confirm the regression fails before the CSS change and passes afterward.
- Run the complete `NewSessionWizard`, provider-options, App, and viewport-related web suites.
- Build and inspect the form at an iPhone-sized viewport, verifying that the lower Codex controls and session
  actions are reachable while the application layer behind the modal does not move.
- Run project typecheck, lint, formatting, build, and the full test suite before release.

## Release

The fix will be independently reviewed, squashed to one `burakgon`-authored commit based on the latest
`origin/main`, verified again in release form, and pushed normally to `main` for OTA testing.
