import { readFileSync, writeFileSync } from "node:fs";

const [versionArg, output = "release-notes.md"] = process.argv.slice(2);
const version = (versionArg ?? "").replace(/^v/, "");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("usage: node scripts/release-notes.mjs <major.minor.patch> [output.md]");
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
const heading = `## [${version}]`;
const start = changelog.indexOf(heading);
if (start < 0) throw new Error(`CHANGELOG.md has no ${heading} section`);

const contentStart = changelog.indexOf("\n", start);
const nextSection = changelog.indexOf("\n## [", contentStart + 1);
const notes = changelog.slice(contentStart + 1, nextSection < 0 ? undefined : nextSection).trim();
if (!notes || !/^[-*] /m.test(notes)) throw new Error(`${heading} has no release-note bullets`);

const previous =
  nextSection < 0
    ? undefined
    : /^## \[((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\]/.exec(changelog.slice(nextSection + 1))?.[1];
const fullChangelog = previous
  ? `https://github.com/burakgon/roamcode/compare/v${previous}...v${version}`
  : `https://github.com/burakgon/roamcode/blob/v${version}/CHANGELOG.md`;
const body = `${notes}\n\n**Full changelog**: ${fullChangelog}\n`;
writeFileSync(output, body);
console.log(`Wrote v${version} release notes to ${output}`);
