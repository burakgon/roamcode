<!-- Thanks for the PR! Keep it focused; conventional commit subject (feat(scope): … / fix(scope): …). -->

## What & why

<!-- What does this change, and what problem does it solve? Link any issue. -->

## How it was verified

<!-- Tests added/updated? For tricky areas, note real-data / live verification. -->

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` + `pnpm format:check` clean
- [ ] `pnpm test` green (incl. the `qa-replay` parity suite if you touched the protocol/reducer/transcript paths)
- [ ] `pnpm build` succeeds
- [ ] New behavior has tests / the bug fix has a regression test
