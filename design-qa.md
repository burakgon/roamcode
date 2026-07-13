# Design QA — compact provider usage rail

- Source visual truth: `/tmp/roamcode-usage-qa-final/mobile-qa.html.png`
- Rendered implementation: `/tmp/roamcode-implementation-qa-ssr-shot/roamcode-implementation-qa.html.png`
- Direct comparison: `/tmp/roamcode-design-qa/comparison-shot/comparison.html.png`
- Viewport: 390 px mobile rail, dark theme, collapsed limit rows, Claude and Codex authenticated
- State: two limits per provider; shortened reset times visible; exact reset detail closed

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: the production component uses Roamcode's existing JetBrains Mono and system/Inter tokens. Labels, values, reset times, and hierarchy match the selected compact direction without mobile text inflation.
- Spacing and layout rhythm: both providers use two 25 px limit rows, one provider mark spanning each pair, and one full-width vertical card. Mobile and desktop share the same density. The session list begins directly after usage.
- Colors and visual tokens: Claude remains coral, Codex remains blue, and low remaining values use the existing warning token without changing provider bar identity.
- Image and asset fidelity: the production component uses the repository's real Claude and OpenAI provider SVG assets; no placeholder or CSS-drawn provider marks were introduced.
- Copy and content: `Sessions` appears once. `Usage`, `Remaining`, `5h`, `Week`, percentage remaining, and shortened reset times remain visible.
- Affordances and accessibility: each reported limit is a labeled button with a progressbar and `aria-expanded`; activating it exposes the full reset time. Missing limits remain disabled and explicitly described as unreported.

## Comparison history

1. The first implementation pass left the provider icon aligned to the start of its 27 px group column.
2. The icon container was centered and the implementation was recaptured.
3. The final 390 px comparison shows equal compact density, one `Sessions` heading, four readable limit rows, and provider-specific colors.

## Implementation checklist

- [x] One non-repeated `Sessions` heading
- [x] Compact identical desktop/mobile row density
- [x] Two vertically stacked limits per provider
- [x] Visible shortened reset times and expandable exact reset detail
- [x] Real provider assets and provider-specific colors
- [x] Focused component tests, TypeScript, lint, formatting, and rendered visual comparison

## Follow-up polish

No blocking polish remains. The production header intentionally keeps its existing icon-only New action instead of the prototype's temporary `New` label.

final result: passed
