import { writeFileSync } from "node:fs";

const [versionArg, url, sha256, output = "Formula/roamcode.rb"] = process.argv.slice(2);
const version = (versionArg ?? "").replace(/^v/, "");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !url || !/^[a-f0-9]{64}$/.test(sha256 ?? "")) {
  throw new Error("usage: render-homebrew-formula.mjs <version> <npm-tarball-url> <sha256> [output]");
}

writeFileSync(
  output,
  `class Roamcode < Formula
  desc "Operate Claude Code or Codex sessions remotely"
  homepage "https://roamcode.ai"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"
  depends_on "tmux"

  def install
    system "npm", "install", *std_npm_args(ignore_scripts: false), "--omit=dev", "--allow-scripts=better-sqlite3,node-pty"
    bin.install_symlink libexec/"bin/roamcode"
  end

  test do
    assert_equal "${version}", shell_output("#{bin}/roamcode --version").strip
  end
end
`,
);
