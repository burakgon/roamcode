# Homebrew tap

The permanent macOS channel is `burakgon/roamcode` (repository `burakgon/homebrew-roamcode`). The release
workflow renders and pushes `Formula/roamcode.rb` only after all three npm packages are published. Users run:

```sh
brew install burakgon/roamcode/roamcode
roamcode install
```

`brew upgrade roamcode` updates the foreground CLI. The explicit `roamcode install` command installs or
updates the always-on managed service through the same code path as `npx roamcode@latest install`.
