# Design QA — reset times in the compact usage rail

- Source visual truth: maintainer-supplied design reference (not stored in the repository)
- Rendered implementation: `/tmp/roamcode-reset-qa/shot-v2/implementation-v2.html.png`
- Direct 300 px comparison: `/tmp/roamcode-reset-qa/compare/shot/comparison.html.png`
- Viewports: 300 px desktop rail and 390 px mobile rail, dark theme
- State: Claude 5h/weekly plus missing Codex 5h and reported Codex weekly limit

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: the reset date and time now use separate compact mono lines. Both remain readable at 300 px without ellipsis; percentages retain the stronger hierarchy.
- Spacing and layout rhythm: each metric remains a 25 px row. The reset column is a deliberate 60 px track, the progress bar keeps useful width, and mobile does not inflate the component.
- Colors and visual tokens: Claude stays coral, Codex stays blue, and warning percentages retain the existing amber semantic token.
- Image and asset fidelity: the component continues to use the repository's real Claude and OpenAI SVG assets.
- Copy and content: `Usage`, `Remaining`, and `Reset` now label the three data roles explicitly. Full date and time are visible as `Jul 18` / `4am` and `Jul 19` / `11:30pm`.
- Interaction and accessibility: ordinary pointer hover no longer creates the oversized bordered capsule. Keyboard focus remains visible. Each limit's accessible label and expandable detail retain the full provider-reported reset string.

## Comparison history

1. Live evidence showed `Jul 18 at…` and `Jul 19 at…` clipped inside a 49 px single-line reset column; the hovered row also gained a visually heavy bordered capsule.
2. A first revision widened the reset column to 80 px and shortened `at` to a middle dot. `Jul 19 · 11:30pm` could still truncate at 300 px.
3. The final revision stacks date and time in a 60 px column, restores bar width, adds a `Reset` header, and removes bordered pointer-hover chrome.
4. The recaptured 300 px and 390 px implementations show complete reset values with unchanged compact row density.

## Implementation checklist

- [x] Full reset date and time visible at 300 px
- [x] Same compact density at 390 px mobile
- [x] No bordered hover capsule
- [x] Separate `Remaining` and `Reset` labels
- [x] Full exact reset text preserved in title, accessible name, and tap disclosure
- [x] UTC and local-timezone regression coverage

## Follow-up polish

No blocking polish remains.

final result: passed
